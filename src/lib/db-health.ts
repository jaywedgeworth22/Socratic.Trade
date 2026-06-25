import { createHash, randomUUID } from "crypto";
import { getDb } from "./db";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceHealthSummary {
  service: string;
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
}

export interface ErrorPatternRow {
  id: string;
  service: string;
  fingerprint: string;
  error_text: string;
  first_seen: string;
  last_seen: string;
  count: number;
}

// ── Write ──────────────────────────────────────────────────────────────────────

export function logApiHealth(opts: {
  service: string;
  ok: boolean;
  latencyMs?: number;
  errorText?: string;
}): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const id = randomUUID();

    db.transaction(() => {
      // Insert log row
      db.prepare(
        `INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, opts.service, now, opts.ok ? 1 : 0, opts.latencyMs ?? null, opts.errorText ?? null);

      // Enforce FIFO cap of 500 rows per service
      db.prepare(
        `DELETE FROM api_health_log
         WHERE service = ?
           AND id NOT IN (
             SELECT id FROM api_health_log
             WHERE service = ?
             ORDER BY ts DESC
             LIMIT 500
           )`
      ).run(opts.service, opts.service);

      // Update error pattern if this is a failure
      if (!opts.ok && opts.errorText) {
        const normalized = opts.errorText.trim().toLowerCase().replace(/\s+/g, " ");
        const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
        const patternId = randomUUID();

        db.prepare(
          `INSERT INTO api_health_error_patterns
             (id, service, fingerprint, error_text, first_seen, last_seen, count)
           VALUES (?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(service, fingerprint) DO UPDATE SET
             last_seen = excluded.last_seen,
             count = count + 1`
        ).run(patternId, opts.service, fingerprint, opts.errorText, now, now);
      }
    })();
  } catch {
    // Health logging must never throw — swallow all errors
  }
}

// ── Read ───────────────────────────────────────────────────────────────────────

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
    const services = listHealthServices();
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    return services.map((service) => {
      const lastSuccess = db
        .prepare(
          `SELECT ts, latency_ms FROM api_health_log
           WHERE service = ? AND ok = 1
           ORDER BY ts DESC LIMIT 1`
        )
        .get(service) as { ts: string; latency_ms: number | null } | undefined;

      const lastFailure = db
        .prepare(
          `SELECT ts, error_text FROM api_health_log
           WHERE service = ? AND ok = 0
           ORDER BY ts DESC LIMIT 1`
        )
        .get(service) as { ts: string; error_text: string | null } | undefined;

      const callsLastHour = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM api_health_log
             WHERE service = ? AND ts >= ?`
          )
          .get(service, hourAgo) as { cnt: number }
      ).cnt;

      const callsLast24h = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM api_health_log
             WHERE service = ? AND ts >= ?`
          )
          .get(service, dayAgo) as { cnt: number }
      ).cnt;

      // "Stopped working" detection
      const last5 = db
        .prepare(
          `SELECT ok FROM api_health_log
           WHERE service = ?
           ORDER BY ts DESC LIMIT 5`
        )
        .all(service) as Array<{ ok: number }>;

      let stoppedWorking = false;
      let stoppedReason: string | null = null;

      if (last5.length >= 5 && last5.every((r) => r.ok === 0)) {
        stoppedWorking = true;
        stoppedReason = "Last 5 consecutive calls all failed";
      } else if (callsLastHour > 0 && !lastSuccess) {
        stoppedWorking = true;
        stoppedReason = "Active in past hour but no successful call ever";
      } else if (
        callsLastHour > 0 &&
        lastSuccess &&
        lastSuccess.ts < hourAgo
      ) {
        stoppedWorking = true;
        stoppedReason = "Active in past hour but no success in 60 min";
      }

      return {
        service,
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
  offset = 0
): HealthLogRow[] {
  try {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, service, ts, ok, latency_ms, error_text
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

export function getServiceErrorPatterns(service: string): ErrorPatternRow[] {
  try {
    const db = getDb();
    return db
      .prepare(
        `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count
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
        `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count
         FROM api_health_error_patterns
         ORDER BY last_seen DESC`
      )
      .all() as ErrorPatternRow[];
    const result: Record<string, ErrorPatternRow[]> = {};
    for (const row of rows) {
      if (!result[row.service]) result[row.service] = [];
      result[row.service].push(row);
    }
    return result;
  } catch {
    return {};
  }
}
