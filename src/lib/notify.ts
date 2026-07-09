// Out-of-app delivery for triggered alerts (and any future server-originated notice). Pluggable
// channels — phone push (ntfy/Pushover), webhook, email (Resend), SMS (Twilio) — each gated by
// admin config (server env) except webhook, which only needs a user-supplied URL. The user picks
// channels + per-channel targets in Settings (notification_prefs table); the dispatcher delivers to
// every enabled channel that is both admin-available and has a target. All network calls go through
// an injectable `fetchImpl` so tests stay offline. Ported from reference/atlas-public-src/bff/notify.

import { audit, getNotifyPrefs } from "./db";
import type {
  NotifyChannelDescriptor,
  NotifyChannelId,
  NotifyChannelResult,
  NotifyMessage,
  NotifyPrefs
} from "./types";

export interface NotifyConfig {
  timeoutMs: number;
  /** Total delivery attempts per channel (>=1). A transient failure ("fetch failed"/timeout/5xx/429)
   *  is retried up to this many times so a single network blip never silently drops a critical alert
   *  (block / run_failed / LLM-timeout). Non-transient failures (4xx, bad URL) are NOT retried. */
  retryAttempts: number;
  /** Base backoff between retries in ms (multiplied by the attempt number). 0 disables the wait. */
  retryDelayMs: number;
  push: { provider: "ntfy" | "pushover"; ntfyServer: string; pushoverToken: string };
  email: { provider: "resend"; resendKey: string; from: string };
  sms: { twilioSid: string; twilioToken: string; twilioFrom: string };
}

/** Admin-side delivery config from env. End-user secrets never live here — only in notification_prefs. */
export function loadNotifyConfig(): NotifyConfig {
  const provider = process.env.NOTIFY_PUSH_PROVIDER === "pushover" ? "pushover" : "ntfy";
  const timeoutMs = Number(process.env.NOTIFY_TIMEOUT_MS ?? 5000);
  const retryAttempts = Number(process.env.NOTIFY_RETRY_ATTEMPTS ?? 3);
  const retryDelayMs = Number(process.env.NOTIFY_RETRY_DELAY_MS ?? 400);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
    retryAttempts: Number.isFinite(retryAttempts) && retryAttempts >= 1 ? Math.floor(retryAttempts) : 3,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 400,
    push: {
      provider,
      ntfyServer: process.env.NOTIFY_NTFY_SERVER ?? "https://ntfy.sh",
      pushoverToken: process.env.PUSHOVER_APP_TOKEN ?? ""
    },
    email: {
      provider: "resend",
      resendKey: process.env.RESEND_API_KEY ?? "",
      from: process.env.NOTIFY_EMAIL_FROM ?? ""
    },
    sms: {
      twilioSid: process.env.TWILIO_ACCOUNT_SID ?? "",
      twilioToken: process.env.TWILIO_AUTH_TOKEN ?? "",
      twilioFrom: process.env.TWILIO_FROM ?? ""
    }
  };
}

interface ChannelDef {
  available(cfg: NotifyConfig): boolean;
  target(prefs: NotifyPrefs): string;
  describe(cfg: NotifyConfig): NotifyChannelDescriptor;
  send(target: string, msg: NotifyMessage, ctx: { cfg: NotifyConfig; fetchImpl: typeof fetch; timeoutMs: number }): Promise<void>;
}

function abortSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

/** Delivery failures worth retrying: transient network/timeout errors and 5xx/429 upstreams. A 4xx
 *  (bad target, auth) or a malformed-URL throw is permanent — retrying it just wastes attempts. */
function isTransientDeliveryError(message: string): boolean {
  return /fetch failed|timed? ?out|timeout|abort|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket|HTTP 429|HTTP 5\d\d/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function postOrThrow(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const res = await fetchImpl(url, { ...init, signal: abortSignal(timeoutMs) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? ": " + detail.slice(0, 200) : ""}`);
  }
  return res;
}

// Duplicated (not imported) from notifications.ts's sanitizePushHeaderText to avoid a
// notify.ts <-> notifications.ts import cycle (notifications.ts already imports `notify` from
// this file). Keep the two copies in sync if the character set changes. See the ntfy branch of
// CHANNELS.push.send below for why this exists (ByteString-only HTTP header values).
const NTFY_TITLE_TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2012\u2013\u2014\u2015]/g, "-"], // figure/en/em/horizontal-bar dashes
  [/\u2026/g, "..."], // horizontal ellipsis
  [/[\u2192\u21D2\u27F6\u279D\u27A1]/g, "->"], // rightwards arrow variants
  [/[\u2190\u21D0\u27F5]/g, "<-"], // leftwards arrow variants
  [/[\u2018\u2019]/g, "'"], // curly single quotes
  [/[\u201C\u201D]/g, '"'] // curly double quotes
];

function sanitizeNtfyTitleHeader(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of NTFY_TITLE_TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/[^\u0000-\u00FF]/g, "");
}

const CHANNELS: Record<NotifyChannelId, ChannelDef> = {
  webhook: {
    available: () => true,
    target: (p) => p.webhookUrl || "",
    describe: () => ({
      id: "webhook",
      label: "Webhook",
      available: true,
      targetField: "webhookUrl",
      targetLabel: "Webhook URL",
      placeholder: "https://example.com/hooks/alerts",
      hint: "We POST a JSON payload here when an alert fires."
    }),
    async send(url, msg, { fetchImpl, timeoutMs }) {
      if (!/^https:\/\//i.test(url)) throw new Error("webhook URL must be https");
      await postOrThrow(
        fetchImpl,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "SocraticTrade-Alerts/1" },
          body: JSON.stringify({
            source: "socratic-trade",
            kind: msg.kind ?? "alert",
            title: msg.title,
            body: msg.body,
            data: msg.data ?? null,
            sent_at: new Date().toISOString()
          })
        },
        timeoutMs
      );
    }
  },

  push: {
    available: (cfg) => cfg.push.provider === "ntfy" || (cfg.push.provider === "pushover" && !!cfg.push.pushoverToken),
    target: (p) => p.pushTarget || "",
    describe: (cfg) => {
      const isPushover = cfg.push.provider === "pushover";
      return {
        id: "push",
        label: "Phone push",
        available: CHANNELS.push.available(cfg),
        provider: cfg.push.provider,
        targetField: "pushTarget",
        targetLabel: isPushover ? "Pushover user key" : "ntfy topic",
        placeholder: isPushover ? "u1a2b3c4d5..." : "alerts-yourname-7c3f",
        hint: isPushover
          ? "Install Pushover, then paste your user key. Notices arrive on your phone."
          : `Free — no key needed. Install the ntfy app, subscribe to a hard-to-guess topic, then paste that exact topic here (server: ${cfg.push.ntfyServer}).`
      };
    },
    async send(target, msg, { cfg, fetchImpl, timeoutMs }) {
      if (cfg.push.provider === "pushover") {
        const form = new URLSearchParams({ token: cfg.push.pushoverToken, user: target, title: msg.title, message: msg.body });
        await postOrThrow(
          fetchImpl,
          "https://api.pushover.net/1/messages.json",
          { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
          timeoutMs
        );
      } else {
        const base = cfg.push.ntfyServer.replace(/\/+$/, "");
        const topic = encodeURIComponent(target.replace(/^\/+/, ""));
        await postOrThrow(
          fetchImpl,
          `${base}/${topic}`,
          // ntfy carries the title as a raw HTTP header value, which the Fetch/Headers spec requires
          // to be ByteString (Latin-1 only) — an em dash or other non-Latin-1 char in msg.title (e.g.
          // from a provider-health alert string) throws `TypeError: Cannot convert argument to a
          // ByteString` here and silently drops the whole push send. Sanitize just the header value
          // (the body isn't header-encoded, so it can stay as-is).
          { method: "POST", headers: { "content-type": "text/plain", title: sanitizeNtfyTitleHeader(msg.title) }, body: msg.body },
          timeoutMs
        );
      }
    }
  },

  email: {
    available: (cfg) => cfg.email.provider === "resend" && !!cfg.email.resendKey && !!cfg.email.from,
    target: (p) => p.email || "",
    describe: (cfg) => ({
      id: "email",
      label: "Email",
      available: CHANNELS.email.available(cfg),
      targetField: "email",
      targetLabel: "Email address",
      placeholder: "you@example.com",
      hint: "Alerts are emailed to this address."
    }),
    async send(to, msg, { cfg, fetchImpl, timeoutMs }) {
      await postOrThrow(
        fetchImpl,
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.email.resendKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: cfg.email.from, to: [to], subject: msg.title, text: msg.body })
        },
        timeoutMs
      );
    }
  },

  sms: {
    available: (cfg) => !!cfg.sms.twilioSid && !!cfg.sms.twilioToken && !!cfg.sms.twilioFrom,
    target: (p) => p.phone || "",
    describe: (cfg) => ({
      id: "sms",
      label: "SMS",
      available: CHANNELS.sms.available(cfg),
      targetField: "phone",
      targetLabel: "Mobile number",
      placeholder: "+14155551234",
      hint: "Standard carrier message rates may apply."
    }),
    async send(to, msg, { cfg, fetchImpl, timeoutMs }) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sms.twilioSid)}/Messages.json`;
      const authToken = Buffer.from(`${cfg.sms.twilioSid}:${cfg.sms.twilioToken}`).toString("base64");
      const form = new URLSearchParams({ From: cfg.sms.twilioFrom, To: to, Body: `${msg.title}\n${msg.body}`.slice(0, 1500) });
      await postOrThrow(
        fetchImpl,
        url,
        { method: "POST", headers: { authorization: `Basic ${authToken}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
        timeoutMs
      );
    }
  }
};

const CHANNEL_ORDER: NotifyChannelId[] = ["push", "webhook", "email", "sms"];

/** UI metadata: which channels exist, which are admin-usable, and the target each needs. */
export function describeChannels(cfg: NotifyConfig = loadNotifyConfig()): NotifyChannelDescriptor[] {
  return CHANNEL_ORDER.map((id) => CHANNELS[id].describe(cfg));
}

/**
 * Deliver `msg` to every channel the user enabled that is both admin-available and has a target.
 * Returns a per-channel result list and never throws — a failing channel is recorded, others run.
 */
export async function notify(
  userId: string,
  msg: NotifyMessage,
  deps: { config?: NotifyConfig; fetchImpl?: typeof fetch; prefs?: NotifyPrefs } = {}
): Promise<NotifyChannelResult[]> {
  const cfg = deps.config ?? loadNotifyConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const prefs = deps.prefs ?? getNotifyPrefs(userId);
  const results: NotifyChannelResult[] = [];
  for (const id of prefs.channels ?? []) {
    const channel = CHANNELS[id];
    if (!channel.available(cfg)) {
      results.push({ channel: id, ok: false, skipped: "not_configured" });
      continue;
    }
    const target = channel.target(prefs);
    if (!target) {
      results.push({ channel: id, ok: false, skipped: "no_target" });
      continue;
    }
    // Deliver with bounded retry: a transient blip (the ~7% "fetch failed"/timeout to ntfy/resend seen
    // in prod) must not silently drop a critical alert. Permanent failures (4xx/bad target) fail fast.
    const attempts = Math.max(1, cfg.retryAttempts);
    let lastError = "";
    let delivered = false;
    let usedAttempts = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      usedAttempts = attempt;
      try {
        await channel.send(target, msg, { cfg, fetchImpl, timeoutMs: cfg.timeoutMs });
        delivered = true;
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < attempts && isTransientDeliveryError(lastError)) {
          await sleep(cfg.retryDelayMs * attempt);
          continue;
        }
        break;
      }
    }
    if (delivered) {
      results.push({ channel: id, ok: true });
      audit("notify.sent", { userId, channel: id, kind: msg.kind ?? "alert", ...(usedAttempts > 1 ? { attempts: usedAttempts } : {}) }, userId);
    } else {
      results.push({ channel: id, ok: false, error: lastError });
      audit("notify.error", { userId, channel: id, error: lastError, attempts: usedAttempts }, userId);
    }
  }
  return results;
}
