"use client";

/** Delivery channels — where out-of-app alerts actually go (phone push,
 *  webhook, email, SMS). Reads GET /api/notifications (channel availability +
 *  saved prefs), writes POST /api/notifications, and exercises every enabled
 *  channel via the existing test endpoint. A channel can only be enabled when
 *  the server operator has configured its provider (e.g. email needs a Resend
 *  key) — unavailable ones say so instead of failing silently.
 *
 *  Auto-saves like every other settings card (owner-directed 2026-07-09):
 *  channel toggles save on change, each channel's target field saves on
 *  blur. saveDeliveryPrefs is a whole-object POST, so every write sends the
 *  full merged prefs (saved ∪ any other in-progress local edits) — never
 *  just the one changed field — so a toggle never drops a pending target
 *  edit in a sibling field, and vice versa. */

import { useCallback, useEffect, useState } from "react";
import { savePolicy, sendTestNotification, ConsoleApiError } from "../lib/api";
import { useAutoSave } from "../lib/useAutoSave";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { SaveStatus } from "../ui/save-status";
import { Btn, Card, Field, TextInput, Toggle } from "../ui/primitives";
import {
  fetchDeliverySettings,
  saveDeliveryPrefs,
  EMPTY_DELIVERY_PREFS,
  type DeliveryChannelDescriptor,
  type DeliveryPrefs
} from "./lib";

const CHANNEL_TITLE: Record<DeliveryChannelDescriptor["id"], string> = {
  push: "A push notification on your phone via a notification app — usually the fastest and cheapest channel.",
  pushover: "Pushover push notifications to your phone. Needs user key.",
  webhook: "An HTTPS POST with a JSON payload to any URL you control (chat webhooks get rich embeds).",
  email: "An email per alert. Needs the server operator to have configured an email provider.",
  sms: "A text message per alert. Needs the server operator's Twilio credentials; carrier rates may apply."
};

type TargetField = "pushTarget" | "pushoverTarget" | "webhookUrl" | "email" | "phone";

interface TestResult {
  channel: string;
  ok: boolean;
  skipped?: string;
  error?: string;
}

/** The OLDER, separate webhook mechanism: policy.notificationSettings.webhookUrl
 *  (written via savePolicy, distinct from the Webhook CHANNEL's own target field
 *  above, which lives in NotifyPrefs and is written via saveDeliveryPrefs). This
 *  one fires for every enabled event in Event notifications, unconditionally —
 *  it does not depend on the Webhook channel toggle. Moved here from Event
 *  notifications in the 2026-07-16 IA restructure (UI move only — same
 *  savePolicy write path, same commit-on-blur / revert-on-error semantics) so
 *  both webhook knobs sit together instead of splitting across two cards. */
function WebhookUrlRow() {
  const { snapshot, refresh } = useConsoleData();
  const autoSave = useAutoSave();
  const [localWebhook, setLocalWebhook] = useState<string | null>(null);
  if (!snapshot) return null;

  const current = snapshot.policy.notificationSettings;
  const webhook = localWebhook ?? current.webhookUrl ?? "";

  const commitWebhook = () => {
    const next = webhook.trim();
    if (next === (current.webhookUrl ?? "")) return; // unchanged → no write
    const prev = webhook;
    // Server validates (400 on a non-URL); revert the field on failure.
    autoSave.save(() => savePolicy({ notificationSettings: { webhookUrl: next } }).then(() => refresh()), {
      onError: () => setLocalWebhook(prev),
      errorTitle: "Webhook not saved"
    });
  };

  return (
    <div className="mt-2 max-w-md">
      <Field label="Webhook URL (optional)" hint="Rich embeds for chat webhooks; generic JSON otherwise." htmlFor="webhook">
        <TextInput
          id="webhook"
          value={webhook}
          placeholder="https://…"
          title="Every enabled event in Event notifications above is also POSTed to this URL. Chat webhooks (Discord/Slack) get rich embeds; anything else gets plain JSON. Saves when you click away."
          onChange={(e) => setLocalWebhook(e.target.value)}
          onBlur={commitWebhook}
        />
      </Field>
    </div>
  );
}

export function DeliveryChannelsCard() {
  const toast = useToast();
  const autoSave = useAutoSave();
  const [channels, setChannels] = useState<DeliveryChannelDescriptor[] | null>(null);
  const [saved, setSaved] = useState<DeliveryPrefs>(EMPTY_DELIVERY_PREFS);
  // Sticky optimistic overlay: seeded from the loaded snapshot, updated
  // immediately on toggle/blur for instant feedback, reverted per-field by
  // useAutoSave's onError if a write fails.
  const [local, setLocal] = useState<DeliveryPrefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [results, setResults] = useState<TestResult[] | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await fetchDeliverySettings();
      setChannels(body.channels ?? []);
      const prefs = { ...EMPTY_DELIVERY_PREFS, ...body.prefs, channels: body.prefs?.channels ?? [] };
      setSaved(prefs);
      setLocal(prefs);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ConsoleApiError ? error.message : "Could not load delivery channels.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const prefs = local ?? saved;
  const busy = autoSave.saving || testBusy;

  // Persist the full merged prefs object (whole-object POST) and adopt the
  // server's response as the new saved/local baseline.
  const persist = (next: DeliveryPrefs, opts: { onError: () => void; successToast?: { title: string; detail?: string } }) => {
    autoSave.save(
      async () => {
        const { prefs: persisted } = await saveDeliveryPrefs(next);
        const merged = { ...EMPTY_DELIVERY_PREFS, ...persisted, channels: persisted?.channels ?? [] };
        setSaved(merged);
        setLocal(merged);
      },
      opts
    );
  };

  const toggleChannel = (id: string, on: boolean) => {
    const prevChannels = prefs.channels;
    const nextChannels = on ? Array.from(new Set([...prefs.channels, id])) : prefs.channels.filter((c) => c !== id);
    const next = { ...prefs, channels: nextChannels };
    setLocal(next);
    const label = channels?.find((c) => c.id === id)?.label ?? id;
    persist(next, {
      onError: () => setLocal((l) => (l ? { ...l, channels: prevChannels } : l)),
      successToast: { title: `${label} delivery ${on ? "on" : "off"}` }
    });
  };

  const targetValue = (field: TargetField) => prefs[field];
  const setTarget = (field: TargetField, value: string) => setLocal((l) => ({ ...(l ?? prefs), [field]: value }));

  const commitTarget = (field: TargetField) => {
    const raw = targetValue(field);
    const trimmed = raw.trim();
    const savedValue = saved[field];
    if (trimmed === savedValue) {
      // No real change (or just whitespace trimmed) — no write, but normalize
      // the visible value.
      if (trimmed !== raw) setLocal((l) => (l ? { ...l, [field]: trimmed } : l));
      return;
    }
    const next = { ...prefs, [field]: trimmed };
    setLocal(next);
    persist(next, {
      onError: () => setLocal((l) => (l ? { ...l, [field]: savedValue } : l))
    });
  };

  const sendTest = async () => {
    setTestBusy(true);
    setResults(null);
    try {
      // Fires against whatever's already saved on the server — channels now
      // auto-save on toggle and targets on blur, so there's nothing to
      // persist first.
      const { results: r } = await sendTestNotification();
      setResults(r);
      const sent = r.filter((x) => x.ok).length;
      if (sent > 0) toast.push("pos", `Test sent via ${sent} channel${sent > 1 ? "s" : ""}`, "Check that it actually arrived before trusting real-money alerts.");
      else toast.push("warn", "No channel delivered", "Check the toggles, targets, and the server's provider keys.");
    } catch (error) {
      toast.push("neg", "Test failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <Card
      title="Delivery channels"
      action={
        <div className="flex items-center gap-3">
          <SaveStatus status={autoSave.status} />
          <Btn
            size="sm"
            disabled={busy || channels === null}
            onClick={() => void sendTest()}
            title="Fires a test alert through every enabled, saved channel so you can confirm it reaches you."
          >
            {testBusy ? "Sending…" : "Send test"}
          </Btn>
        </div>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Where alerts leave the app — one setup for your whole login, across every account. Which events fire is chosen
        in Event notifications above; this is how they reach you. Without any channel, events are still recorded in
        Activity, just not pushed anywhere.
      </p>

      {loadError && (
        <p className="mb-3 rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void load()} title="Try loading the channels again.">
            Retry
          </button>
        </p>
      )}

      {channels === null && !loadError && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Loading channels…</p>
      )}

      {channels !== null && (
        <div className="flex flex-col gap-2">
          {channels.map((ch) => {
            const on = prefs.channels.includes(ch.id);
            const target = targetValue(ch.targetField as TargetField);
            return (
              <div
                key={ch.id}
                className="rounded-control border border-[color:var(--con-line)] p-3 transition-colors hover:bg-[color:var(--con-surface-2)] focus-within:bg-[color:var(--con-surface-2)]"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[length:var(--con-fs-sm)] font-semibold" title={CHANNEL_TITLE[ch.id]}>
                      {ch.label}
                    </span>
                    {ch.id === "push" && ch.available && (
                      <span
                        className="rounded-full border border-[color:var(--con-pos-border)] bg-[color:var(--con-pos-soft)] px-2 py-0.5 text-[length:var(--con-fs-2xs)] font-bold uppercase tracking-wide text-[color:var(--con-pos)]"
                        title={
                          ch.provider === "pushover"
                            ? "Phone push via Pushover — paste your Pushover user key as the target. Server needs PUSHOVER_APP_TOKEN + NOTIFY_PUSH_PROVIDER=pushover."
                            : "Phone push via ntfy (free topic) or Pushover (server: NOTIFY_PUSH_PROVIDER=pushover + PUSHOVER_APP_TOKEN). Paste the topic or user key below."
                        }
                      >
                        {ch.provider === "pushover" ? "pushover" : "recommended · free"}
                      </span>
                    )}
                    {!ch.available && (
                      <span
                        className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
                        title="The server operator hasn't configured this channel's provider, so it can't be enabled from here."
                      >
                        not configured on the server
                      </span>
                    )}
                  </div>
                  <Toggle
                    checked={on}
                    disabled={!ch.available || busy}
                    onChange={(next) => toggleChannel(ch.id, next)}
                    label={`${ch.label} channel`}
                  />
                </div>
                {on && ch.available && (
                  <div className="mt-2 max-w-md">
                    <Field label={ch.targetLabel} hint={ch.hint} htmlFor={`ch-${ch.id}`}>
                      <TextInput
                        id={`ch-${ch.id}`}
                        value={typeof target === "string" ? target : ""}
                        placeholder={ch.placeholder}
                        onChange={(e) => setTarget(ch.targetField as TargetField, e.target.value)}
                        onBlur={() => commitTarget(ch.targetField as TargetField)}
                        title={ch.hint}
                      />
                    </Field>
                  </div>
                )}
                {/* The older, always-on legacy webhook (see WebhookUrlRow above) sits under this
                    channel's toggle regardless of whether the toggle is on — it's a separate
                    field, not the channel's own target. */}
                {ch.id === "webhook" && <WebhookUrlRow />}
              </div>
            );
          })}
        </div>
      )}

      {results && (
        <ul className="mt-3 flex flex-col gap-1 text-[length:var(--con-fs-xs)]">
          {results.length === 0 && <li className="text-[color:var(--con-muted)]">No channels enabled — toggle one above first.</li>}
          {results.map((r, i) => (
            <li
              key={i}
              className={r.ok ? "text-[color:var(--con-pos)]" : "text-[color:var(--con-muted)]"}
              title={r.ok ? "The test message was accepted by the provider." : r.skipped ? "Skipped — the channel is off, has no target, or its provider isn't configured." : r.error ?? "The provider rejected the test."}
            >
              {r.ok ? "✓" : "—"} {r.channel}
              {r.skipped ? ` (${r.skipped.replace(/_/g, " ")})` : r.ok ? " — sent" : ` — failed${r.error ? `: ${r.error}` : ""}`}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
