import { createHash, randomUUID } from "crypto";
import { getDb } from "./db";

// `stoppedWorking` is set for a few distinct reasons (see getServiceHealthSummaries). This one is the
// "5 consecutive failures" condition — the only one strong enough to act on automatically (e.g. the
// enrichment circuit breaker), as opposed to the softer "no success yet this hour" heuristics that a
// single cold failure can trip. Exported so consumers key off the condition, not a brittle string.
export const HEALTH_REASON_CONSECUTIVE_FAILURES = "Last 5 consecutive calls all failed";

/**
 * Per-credential-lane health for the API circuit breaker. A "lane" is (service, keySource) — the SAME
 * granularity `getServiceHealthSummaries` and the whole health store already use — NOT per-user, so a
 * globally-dead env key trips once (not per user) and a user's own bad key trips only that user's lane
 * without stopping the shared env lane. `stoppedWorking` reuses the exact predicate below (kept in sync
 * with getServiceHealthSummaries): the last 5 calls all failed, or active-this-hour with no recent
 * success. Read-only; never throws (returns a not-stopped default on any DB error).
 */
export function getLaneHealth(
  service: string,
  keySource: string | null
): { stoppedWorking: boolean; reason: string | null; lastFailureTs: string | null } {
  try {
    const db = getDb();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const last5 = db
      .prepare(`SELECT ok FROM api_health_log WHERE service = ? AND key_source IS ? ORDER BY ts DESC LIMIT 5`)
      .all(service, keySource) as Array<{ ok: number }>;
    const lastSuccess = db
      .prepare(`SELECT ts FROM api_health_log WHERE service = ? AND key_source IS ? AND ok = 1 ORDER BY ts DESC LIMIT 1`)
      .get(service, keySource) as { ts: string } | undefined;
    const lastFailure = db
      .prepare(`SELECT ts FROM api_health_log WHERE service = ? AND key_source IS ? AND ok = 0 ORDER BY ts DESC LIMIT 1`)
      .get(service, keySource) as { ts: string } | undefined;
    const callsLastHour = (
      db.prepare(`SELECT COUNT(*) as cnt FROM api_health_log WHERE service = ? AND key_source IS ? AND ts >= ?`).get(service, keySource, hourAgo) as { cnt: number }
    ).cnt;

    let stoppedWorking = false;
    let reason: string | null = null;
    if (last5.length >= 5 && last5.every((r) => r.ok === 0)) {
      stoppedWorking = true;
      reason = HEALTH_REASON_CONSECUTIVE_FAILURES;
    } else if (callsLastHour > 0 && !lastSuccess) {
      stoppedWorking = true;
      reason = "Active in past hour but no successful call ever";
    } else if (callsLastHour > 0 && lastSuccess && lastSuccess.ts < hourAgo) {
      stoppedWorking = true;
      reason = "Active in past hour but no success in 60 min";
    }
    return { stoppedWorking, reason, lastFailureTs: lastFailure?.ts ?? null };
  } catch {
    return { stoppedWorking: false, reason: null, lastFailureTs: null };
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceHealthSummary {
  service: string;
  keySource: string | null;
  lastSuccessTs: string | null;
  lastSuccessLatencyMs: number | null;
  lastFailureTs: string | null;
  lastFailureError: string | null;
  callsLastHour: number;
  callsLast24h: number;
  stoppedWorking: boolean;
  stoppedReason: string | null;
}

export interface HealthLogRow {
  id: string;
  service: string;
  ts: string;
  ok: number;
  latency_ms: number | null;
  error_text: string | null;
  key_source: string | null;
  user_id: string | null;
}

export interface ErrorPatternRow {
  id: string;
  service: string;
  fingerprint: string;
  error_text: string;
  first_seen: string;
  last_seen: string;
  count: number;
  key_source: string | null;
}

// ── Write ──────────────────────────────────────────────────────────────────────

export function logApiHealth(opts: {
  service: string;
  ok: boolean;
  latencyMs?: number;
  errorText?: string;
  keySource?: string;
  userId?: string;
}): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();
    const keySource = opts.keySource ?? null;
    const userId = opts.userId ?? null;

    db.transaction(() => {
      // Insert log row
      db.prepare(
        `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, opts.service, now, opts.ok ? 1 : 0, opts.latencyMs ?? null, opts.errorText ?? null, keySource, userId);

      // Enforce FIFO cap of 500 rows per (service, key_source) credential lane
      db.prepare(
        `DELETE FROM api_health_log
         WHERE service = ? AND key_source IS ?
           AND id NOT IN (
             SELECT id FROM api_health_log
             WHERE service = ? AND key_source IS ?
             ORDER BY ts DESC
             LIMIT 500
           )`
      ).run(opts.service, keySource, opts.service, keySource);

      // Update error pattern if this is a failure.
      // Use "" (not NULL) as the key_source sentinel so UNIQUE(service,fingerprint,key_source)
      // deduplicates correctly — SQLite NULL values never collide in UNIQUE constraints.
      if (!opts.ok && opts.errorText) {
        const normalized = opts.errorText.trim().toLowerCase().replace(/\s+/g, " ");
        const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
        const patternId = randomUUID();
        const patternKeySource = keySource ?? "";

        db.prepare(
          `INSERT INTO api_health_error_patterns
             (id, service, fingerprint, error_text, first_seen, last_seen, count, key_source)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(service, fingerprint, key_source) DO UPDATE SET
             last_seen = excluded.last_seen,
             count = count + 1`
        ).run(patternId, opts.service, fingerprint, opts.errorText, now, now, patternKeySource);
      }
    })();

    if (!opts.ok && opts.errorText) {
      const keySource = opts.keySource ?? null;
      const lane = getLaneHealth(opts.service, keySource);
      if (lane.stoppedWorking) {
        void alertConnectionFailure(opts.service, keySource, opts.userId ?? null, opts.errorText);
      }
    }
  } catch {
    // Health logging must never throw — swallow all errors
  }
}

// ── Read ───────────────────────────────────────────────────────────────────────

interface ServiceKeyLane { service: string; key_source: string | null }

function listHealthLanes(): ServiceKeyLane[] {
  try {
    const db = getDb();
    return db
      .prepare(`SELECT DISTINCT service, key_source FROM api_health_log ORDER BY service, key_source`)
      .all() as ServiceKeyLane[];
  } catch {
    return [];
  }
}

export function listHealthServices(): string[] {
  try {
    const db = getDb();
    const rows = db
      .prepare(`SELECT DISTINCT service FROM api_health_log ORDER BY service`)
      .all() as Array<{ service: string }>;
    return rows.map((r) => r.service);
  } catch {
    return [];
  }
}

export function getServiceHealthSummaries(): ServiceHealthSummary[] {
  try {
    const db = getDb();
    const lanes = listHealthLanes();
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    return lanes.map(({ service, key_source: ks }) => {
      const lastSuccess = db
        .prepare(
          `SELECT ts, latency_ms FROM api_health_log
           WHERE service = ? AND key_source IS ? AND ok = 1
           ORDER BY ts DESC LIMIT 1`
        )
        .get(service, ks) as { ts: string; latency_ms: number | null } | undefined;

      const lastFailure = db
        .prepare(
          `SELECT ts, error_text FROM api_health_log
           WHERE service = ? AND key_source IS ? AND ok = 0
           ORDER BY ts DESC LIMIT 1`
        )
        .get(service, ks) as { ts: string; error_text: string | null } | undefined;

      const callsLastHour = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM api_health_log
             WHERE service = ? AND key_source IS ? AND ts >= ?`
          )
          .get(service, ks, hourAgo) as { cnt: number }
      ).cnt;

      const callsLast24h = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM api_health_log
             WHERE service = ? AND key_source IS ? AND ts >= ?`
          )
          .get(service, ks, dayAgo) as { cnt: number }
      ).cnt;

      // "Stopped working" detection — scoped per credential lane
      const last5 = db
        .prepare(
          `SELECT ok FROM api_health_log
           WHERE service = ? AND key_source IS ?
           ORDER BY ts DESC LIMIT 5`
        )
        .all(service, ks) as Array<{ ok: number }>;

      let stoppedWorking = false;
      let stoppedReason: string | null = null;

      if (last5.length >= 5 && last5.every((r) => r.ok === 0)) {
        stoppedWorking = true;
        stoppedReason = HEALTH_REASON_CONSECUTIVE_FAILURES;
      } else if (callsLastHour > 0 && !lastSuccess) {
        stoppedWorking = true;
        stoppedReason = "Active in past hour but no successful call ever";
      } else if (callsLastHour > 0 && lastSuccess && lastSuccess.ts < hourAgo) {
        stoppedWorking = true;
        stoppedReason = "Active in past hour but no success in 60 min";
      }

      return {
        service,
        keySource: ks,
        lastSuccessTs: lastSuccess?.ts ?? null,
        lastSuccessLatencyMs: lastSuccess?.latency_ms ?? null,
        lastFailureTs: lastFailure?.ts ?? null,
        lastFailureError: lastFailure?.error_text ?? null,
        callsLastHour,
        callsLast24h,
        stoppedWorking,
        stoppedReason,
      };
    });
  } catch {
    return [];
  }
}

export function getServiceHealthLog(
  service: string,
  limit = 100,
  offset = 0,
  keySource?: string | null
): HealthLogRow[] {
  try {
    const db = getDb();
    if (keySource !== undefined) {
      return db
        .prepare(
          `SELECT id, service, ts, ok, latency_ms, error_text, key_source, user_id
           FROM api_health_log
           WHERE service = ? AND key_source IS ?
           ORDER BY ts DESC
           LIMIT ? OFFSET ?`
        )
        .all(service, keySource ?? null, limit, offset) as HealthLogRow[];
    }
    return db
      .prepare(
        `SELECT id, service, ts, ok, latency_ms, error_text, key_source, user_id
         FROM api_health_log
         WHERE service = ?
         ORDER BY ts DESC
         LIMIT ? OFFSET ?`
      )
      .all(service, limit, offset) as HealthLogRow[];
  } catch {
    return [];
  }
}

export function getServiceErrorPatterns(
  service: string,
  keySource?: string | null
): ErrorPatternRow[] {
  try {
    const db = getDb();
    if (keySource !== undefined) {
      // Error patterns use "" sentinel (not NULL) so UNIQUE dedup works; map null → ""
      return db
        .prepare(
          `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
           FROM api_health_error_patterns
           WHERE service = ? AND key_source = ?
           ORDER BY last_seen DESC`
        )
        .all(service, keySource ?? "") as ErrorPatternRow[];
    }
    return db
      .prepare(
        `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
         FROM api_health_error_patterns
         WHERE service = ?
         ORDER BY last_seen DESC`
      )
      .all(service) as ErrorPatternRow[];
  } catch {
    return [];
  }
}

export function getAllErrorPatterns(): Record<string, ErrorPatternRow[]> {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
         FROM api_health_error_patterns
         ORDER BY last_seen DESC`
      )
      .all() as ErrorPatternRow[];
    const result: Record<string, ErrorPatternRow[]> = {};
    for (const row of rows) {
      // key_source is "" for no-key services (sentinel), never NULL in error_patterns
      const lane = `${row.service}:${row.key_source ?? ""}`;
      if (!result[lane]) result[lane] = [];
      result[lane].push(row);
    }
    return result;
  } catch {
    return {};
  }
}

// ── Connection Health & Storage Alerts ────────────────────────────────────────

const HEALTH_ALERT_COOLDOWN_PREFIX = "healthAlertSent";
const HEALTH_ALERT_COOLDOWN_MS = 6 * 60 * 60_000; // 6 hours

const STORAGE_ALERT_COOLDOWN_PREFIX = "storageAlertSent";
const STORAGE_ALERT_COOLDOWN_MS = 12 * 60 * 60_000; // 12 hours

function operatorAlertEmail(): string | undefined {
  return (
    process.env.USAGE_LIMIT_ALERT_EMAIL?.trim() ||
    process.env.ADMIN_ALERT_EMAIL?.trim() ||
    process.env.PRIMARY_USER_EMAIL?.trim() ||
    undefined
  );
}

async function captureHealthSentryMessage(
  level: "warning" | "error",
  message: string,
  context: Record<string, string | number | boolean | null | undefined>
): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  try {
    const mod = (await import("@sentry/nextjs")) as typeof import("@sentry/nextjs") & {
      default?: typeof import("@sentry/nextjs");
    };
    const captureMessage = mod.captureMessage ?? mod.default?.captureMessage;
    const withScope = mod.withScope ?? mod.default?.withScope;
    if (typeof captureMessage !== "function" || typeof withScope !== "function") return;
    withScope((scope) => {
      scope.setLevel(level);
      scope.setTag("component", "api-health");
      if (context.service) scope.setTag("health.service", String(context.service));
      if (context.keySource) scope.setTag("health.key_source", String(context.keySource));
      scope.setContext("api-health", context);
      captureMessage(message);
    });
  } catch {
    // Observability must not affect trading control flow.
  }
}

export async function alertConnectionFailure(
  service: string,
  keySource: string | null,
  userId: string | null,
  errorText: string
): Promise<void> {
  try {
    const targetUserId = userId || "local";
    const actualKeySource = keySource || "none";
    const key = `${HEALTH_ALERT_COOLDOWN_PREFIX}:${service}:${actualKeySource}:${targetUserId}`;

    // Cooldown check
    const { getInternalSetting, setInternalSetting, audit } = await import("./db");
    const last = getInternalSetting<string>(key);
    if (last && Date.now() - Date.parse(last) < HEALTH_ALERT_COOLDOWN_MS) return;
    setInternalSetting(key, new Date().toISOString());

    const isGlobal = actualKeySource !== "user";
    const title = `${service} connection failed`;
    const body = `Connection to ${service} (${actualKeySource} lane) failed: ${errorText}`;

    const payload = {
      service,
      keySource: actualKeySource,
      userId: targetUserId,
      errorText,
      global: isGlobal
    };

    // Log audit event
    audit("connection_health_alert", payload, targetUserId);

    // Send Sentry event
    await captureHealthSentryMessage(isGlobal ? "error" : "warning", title, {
      service,
      keySource: actualKeySource,
      userSpecific: !isGlobal,
      reason: errorText
    });

    if (isGlobal) {
      // Global failures: Route to admin email and health
      const { getNotifyPrefs } = await import("./db");
      const prefs = getNotifyPrefs("local");
      const { loadNotifyConfig, notify } = await import("./notify");

      const fallbackEmail = operatorAlertEmail();
      const config = loadNotifyConfig();

      if (fallbackEmail && config.email.resendKey && config.email.from) {
        if (!prefs.channels.includes("email") || !prefs.email.trim()) {
          const forcedPrefs = {
            ...prefs,
            channels: ["email" as any],
            email: fallbackEmail,
            updatedAt: prefs.updatedAt
          };
          await notify("local", { title, body, kind: "provider_degraded", data: payload }, { config, prefs: forcedPrefs }).catch(() => {});
        } else {
          await notify("local", { title, body, kind: "provider_degraded", data: payload }, { config }).catch(() => {});
        }
      }

      // Also send standard notification
      const { sendNotification } = await import("./notifications");
      const { getPolicy } = await import("./db");
      const policy = getPolicy("local");
      const forcedPolicy = {
        ...policy,
        notificationSettings: {
          ...policy.notificationSettings,
          enabledEvents: Array.from(new Set([...policy.notificationSettings.enabledEvents, "provider_degraded" as const])) as any
        }
      };
      await sendNotification({ type: "provider_degraded", title, payload }, { userId: "local", policy: forcedPolicy as any }).catch(() => {});
    } else {
      // User-key failures: Route to user notifications only
      const { sendNotification } = await import("./notifications");
      const { getPolicy } = await import("./db");
      const policy = getPolicy(targetUserId);
      const forcedPolicy = {
        ...policy,
        notificationSettings: {
          ...policy.notificationSettings,
          enabledEvents: Array.from(new Set([...policy.notificationSettings.enabledEvents, "provider_degraded" as const])) as any
        }
      };
      await sendNotification({ type: "provider_degraded", title, payload }, { userId: targetUserId, policy: forcedPolicy as any }).catch(() => {});

      const { notify } = await import("./notify");
      await notify(targetUserId, { title, body, kind: "provider_degraded", data: payload }).catch(() => {});
    }
  } catch {
    // Health alerts must never throw
  }
}

export async function alertStorageWarning(warningType: string, message: string): Promise<void> {
  try {
    const key = `${STORAGE_ALERT_COOLDOWN_PREFIX}:${warningType}`;
    const { getInternalSetting, setInternalSetting, audit } = await import("./db");
    const last = getInternalSetting<string>(key);
    if (last && Date.now() - Date.parse(last) < STORAGE_ALERT_COOLDOWN_MS) return;
    setInternalSetting(key, new Date().toISOString());

    const title = `Storage Warning: ${warningType.replace(/_/g, " ")}`;
    const body = message;
    const payload = { warningType, message };

    audit("storage_warning_alert", payload, "local");

    // Route to admin email
    const { getNotifyPrefs } = await import("./db");
    const prefs = getNotifyPrefs("local");
    const { loadNotifyConfig, notify } = await import("./notify");

    const fallbackEmail = operatorAlertEmail();
    const config = loadNotifyConfig();

    if (fallbackEmail && config.email.resendKey && config.email.from) {
      if (!prefs.channels.includes("email") || !prefs.email.trim()) {
        const forcedPrefs = {
          ...prefs,
          channels: ["email" as any],
          email: fallbackEmail,
          updatedAt: prefs.updatedAt
        };
        await notify("local", { title, body, kind: "provider_degraded", data: payload }, { config, prefs: forcedPrefs }).catch(() => {});
      } else {
        await notify("local", { title, body, kind: "provider_degraded", data: payload }, { config }).catch(() => {});
      }
    }

    // Also send standard notification
    const { sendNotification } = await import("./notifications");
    const { getPolicy } = await import("./db");
    const policy = getPolicy("local");
    const forcedPolicy = {
      ...policy,
      notificationSettings: {
        ...policy.notificationSettings,
        enabledEvents: Array.from(new Set([...policy.notificationSettings.enabledEvents, "provider_degraded" as const])) as any
      }
    };
    await sendNotification({ type: "provider_degraded", title, payload }, { userId: "local", policy: forcedPolicy as any }).catch(() => {});
  } catch {
    // never throw on warnings
  }
}
