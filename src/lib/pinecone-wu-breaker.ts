// Monthly Pinecone write-unit (WU) exhaustion breaker.
//
// Why this exists (prod, 2026-08): the Pinecone Starter plan caps writes at 2M WUs per
// CALENDAR MONTH. Once a 10-K backfill exhausted it, every hourly ingest cycle kept
// (1) re-EMBEDDING the same documents through paid OpenRouter — storeContexts dedups by
// content_hash of documents that actually STORED, so a failed upsert never records a hash and
// the next cycle pays for the embeds again before the upsert 429s again; (2) spamming
// provider_degraded alerts; (3) churning the durable sec_ingest retry queue. Nothing about
// retrying earlier than the 1st of next month can succeed, so this breaker parks all vector
// WRITES until then. Reads/RAG retrieval are unaffected and stay un-gated.
//
// Owner philosophy check: this is a spend/correctness guard (same class as the R2
// kill-switch), not a trading guardrail — it prevents paying for embeddings that provably
// cannot be stored. It self-clears on expiry AND eagerly on any successful Pinecone write
// (plan upgraded mid-month), and the marker is one internal-settings row the owner can
// delete at any time (see docs/rollouts/2026-08-09-pinecone-wu-breaker.md for the one-liner).
//
// WEBPACK TRAP: this module is reachable from scheduler-adjacent code — do not import "os"
// or use "node:" import specifiers here.

import { audit, deleteInternalSetting, getInternalSetting, setInternalSetting } from "./db";
import { alertStorageWarning } from "./db-health";

/** Internal-settings key holding the ISO instant writes may resume (first day of next month UTC). */
export const PINECONE_WU_EXHAUSTED_UNTIL_KEY = "pinecone:wuExhaustedUntil";
/** Daily watermark so the write-gate audits at most once per UTC day, not once per skipped call. */
const PINECONE_WU_GATE_AUDIT_DAY_KEY = "pinecone:wuGateLastAuditDay";

/**
 * True only for Pinecone's MONTHLY write-unit exhaustion (e.g. "You've reached your write unit
 * limit for the current month (2000000). ... Status: 429."). Deliberately narrow: per-second
 * rate limits, read-unit limits, and other 429s must keep their ordinary retry behavior —
 * only the calendar-month quota is unwinnable before the reset date.
 */
export function isPineconeWuExhaustedError(message: string | null | undefined): boolean {
  if (!message) return false;
  if (!/write unit limit for the current month/i.test(message)) return false;
  return /\b429\b/.test(message) || /rate.?limit|too many requests/i.test(message);
}

/** First day of the NEXT UTC month after `fromMs`, as an ISO instant (the quota reset moment). */
export function firstDayOfNextMonthUtc(fromMs: number = Date.now()): string {
  const from = new Date(fromMs);
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * The active marker's expiry ISO, or null when the breaker is inactive (never tripped, cleared,
 * or expired — expiry IS the auto-resume: an expired marker gates nothing). Never throws;
 * fails open (writes proceed) on any storage error.
 */
export function pineconeWuExhaustedUntil(nowMs: number = Date.now()): string | null {
  try {
    const until = getInternalSetting<string>(PINECONE_WU_EXHAUSTED_UNTIL_KEY);
    if (!until || typeof until !== "string") return null;
    const expiry = Date.parse(until);
    if (!Number.isFinite(expiry)) return null;
    return expiry > nowMs ? until : null;
  } catch {
    return null;
  }
}

/**
 * Trip the breaker from a detected monthly-WU-exhaustion upsert failure. Idempotent per
 * episode: if a marker is already active, nothing is re-written and no second notification
 * goes out (the hourly ingest cycle would otherwise re-detect the same 429 every hour).
 * On the FIRST trip: persists the marker (= first day of next month UTC, computed from the
 * error time), writes one audit row, and emits ONE storage_warning notification (which has
 * its own 12h repeat-dedup in alertStorageWarning as a second belt). Never throws.
 */
export async function tripPineconeWuBreaker(
  input: { message: string; operation?: string; userId?: string },
  nowMs: number = Date.now()
): Promise<{ tripped: boolean; until: string }> {
  try {
    const active = pineconeWuExhaustedUntil(nowMs);
    if (active) return { tripped: false, until: active };
    const until = firstDayOfNextMonthUtc(nowMs);
    setInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY, until);
    const limitMatch = input.message.match(/current month \((\d+)\)/i);
    const limitLabel = limitMatch ? `(${(Number(limitMatch[1]) / 1_000_000).toString()}M)` : "(monthly quota)";
    const resumeDate = until.slice(0, 10);
    audit(
      "pinecone_wu_breaker_tripped",
      {
        until,
        operation: input.operation ?? null,
        reason: input.message.slice(0, 400)
      },
      input.userId ?? "local"
    );
    console.warn(
      `[pinecone-wu-breaker] Monthly write units exhausted ${limitLabel} — vector ingest paused until ${resumeDate}. Reads/RAG retrieval unaffected.`
    );
    await alertStorageWarning(
      "pinecone_write_units_exhausted",
      `Pinecone monthly write units exhausted ${limitLabel} — vector ingest paused until ${resumeDate}. ` +
        "Reads/RAG retrieval unaffected. Upgrade the Pinecone plan or wait for the month to reset."
    );
    return { tripped: true, until };
  } catch {
    // The breaker is an advisory spend guard; it must never turn an upsert failure into a crash.
    return { tripped: false, until: firstDayOfNextMonthUtc(nowMs) };
  }
}

const PINECONE_WRITE_OP_RE = /upsert|commit|update|delete|erase|purge/i;

/**
 * Eager clear: any SUCCESSFUL Pinecone WRITE while a marker exists proves quota is available
 * again (plan upgraded mid-month, or the month rolled over with a stale row left behind).
 * Called from the Pinecone success path with the operation label; read-only operations
 * (query/fetch/list/describe*) never clear — reads succeed even while writes are exhausted.
 * Cheap: the DB read only happens for write-shaped operations. Never throws.
 */
export function notePineconeWriteSuccess(operation?: string): void {
  try {
    if (operation !== undefined && !PINECONE_WRITE_OP_RE.test(operation)) return;
    const existing = getInternalSetting<string>(PINECONE_WU_EXHAUSTED_UNTIL_KEY);
    if (!existing) return;
    deleteInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY);
    audit(
      "pinecone_wu_breaker_cleared",
      { reason: "pinecone-write-succeeded", operation: operation ?? null, hadUntil: existing },
      "local"
    );
    console.log("[pinecone-wu-breaker] Marker cleared — a Pinecone write succeeded; vector ingest resumed.");
  } catch {
    // never throw from a success path
  }
}

/**
 * Audit that the early write-gate skipped work, at most once per UTC day (internal watermark).
 * The gate itself runs on every storeContexts/storeDocument call while the marker is active;
 * auditing each call would flood audit_events for a state that changes at most twice a month.
 */
export function auditPineconeWuGateSkip(
  payload: { operation: string; attempted: number; until: string },
  userId: string = "local"
): void {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (getInternalSetting<string>(PINECONE_WU_GATE_AUDIT_DAY_KEY) === day) return;
    setInternalSetting(PINECONE_WU_GATE_AUDIT_DAY_KEY, day);
    audit("pinecone_wu_gate_skip", payload, userId);
  } catch {
    // audit is best-effort; the gate result itself is the caller's signal
  }
}
