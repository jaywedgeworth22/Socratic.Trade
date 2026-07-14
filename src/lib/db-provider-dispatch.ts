// Crash-durable external-provider dispatch admission and outcome ledger.
//
// A reservation is committed before a paid/network boundary. The caller marks it dispatched
// immediately before invoking the SDK/fetch and settles it after the promise resolves or rejects.
// These writes intentionally do not accept a business-operation lease: usage truth must survive
// lease loss, process crashes, and successor takeover.

import crypto from "crypto";
import { getDb } from "./db";

export type ProviderDispatchOutcome = "succeeded" | "failed" | "unknown";

export interface ProviderDispatchWindow {
  maxUnits: number;
  windowMs: number;
}

export interface ReserveProviderDispatchInput {
  provider: string;
  operation: string;
  credentialRef: string;
  userId?: string;
  units?: number;
  estimatedCostUsd?: number;
  windows?: ProviderDispatchWindow[];
  maxEstimatedCostUsdPer24h?: number;
  authorityId?: string;
  idempotencyKey?: string;
  now?: string;
}

export type ProviderDispatchReservation =
  | { admitted: true; attemptId: string; authorityId: string }
  | { admitted: false; reason: "request_window" | "cost_cap" };

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function providerAuthorityId(explicit?: string): string {
  const configured = explicit?.trim() || process.env.PROVIDER_QUOTA_AUTHORITY_ID?.trim();
  return configured || "socratic-trade-local";
}

function validIso(value: string | undefined): string {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

/**
 * Atomically reserve request units and estimated cost for one credential lane. Every active or
 * completed dispatch remains chargeable inside its windows; only a never-dispatched cancellation
 * is released. `BEGIN IMMEDIATE` serializes competing app processes sharing this SQLite authority.
 */
export function reserveProviderDispatch(input: ReserveProviderDispatchInput): ProviderDispatchReservation {
  const database = getDb();
  const provider = input.provider.trim().toLowerCase();
  const operation = input.operation.trim();
  const credentialRef = input.credentialRef.trim();
  if (!provider || !operation || !credentialRef) throw new Error("Provider dispatch identity is incomplete.");
  const authorityId = providerAuthorityId(input.authorityId);
  const units = positiveInt(input.units, 1);
  const estimatedCostUsd = nonNegative(input.estimatedCostUsd);
  const idempotencyKey = input.idempotencyKey?.trim() || undefined;
  const now = validIso(input.now);
  const nowMs = Date.parse(now);
  const attemptId = crypto.randomUUID();

  const reserve = database.transaction((): ProviderDispatchReservation => {
    if (idempotencyKey) {
      const prior = database.prepare(`
        SELECT id FROM provider_dispatch_attempts
        WHERE authority_id = ? AND idempotency_key = ?
      `).get(authorityId, idempotencyKey) as { id: string } | undefined;
      if (prior) return { admitted: true, attemptId: prior.id, authorityId };
    }
    for (const window of input.windows ?? []) {
      if (!Number.isFinite(window.windowMs) || window.windowMs <= 0 || !Number.isFinite(window.maxUnits) || window.maxUnits < 0) {
        continue;
      }
      const since = new Date(nowMs - window.windowMs).toISOString();
      const row = database.prepare(`
        SELECT COALESCE(SUM(units), 0) AS used
        FROM provider_dispatch_attempts
        WHERE authority_id = ? AND provider = ? AND credential_ref = ?
          AND status <> 'cancelled' AND created_at > ?
      `).get(authorityId, provider, credentialRef, since) as { used: number };
      if (row.used + units > window.maxUnits) return { admitted: false, reason: "request_window" };
    }

    const costCap = input.maxEstimatedCostUsdPer24h;
    if (typeof costCap === "number" && Number.isFinite(costCap) && costCap >= 0) {
      const since = new Date(nowMs - 86_400_000).toISOString();
      const row = database.prepare(`
        SELECT COALESCE(SUM(
          CASE WHEN actual_cost_usd IS NULL THEN estimated_cost_usd
               ELSE MAX(actual_cost_usd, estimated_cost_usd) END
        ), 0) AS used
        FROM provider_dispatch_attempts
        WHERE authority_id = ? AND provider = ? AND credential_ref = ?
          AND status <> 'cancelled' AND created_at > ?
      `).get(authorityId, provider, credentialRef, since) as { used: number };
      if (row.used + estimatedCostUsd > costCap) return { admitted: false, reason: "cost_cap" };
    }

    database.prepare(`
      INSERT INTO provider_dispatch_attempts (
        id, authority_id, provider, operation, credential_ref, user_id, units,
        estimated_cost_usd, status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
    `).run(
      attemptId,
      authorityId,
      provider,
      operation,
      credentialRef,
      input.userId?.trim() || "local",
      units,
      estimatedCostUsd,
      idempotencyKey ?? null,
      now,
      now
    );
    return { admitted: true, attemptId, authorityId };
  });
  return reserve.immediate() as ProviderDispatchReservation;
}

/** Persist the last certain pre-network state. Idempotent across retries/re-entrancy. */
export function markProviderDispatchStarted(attemptId: string, at: string = new Date().toISOString()): void {
  const timestamp = validIso(at);
  const database = getDb();
  database.transaction(() => {
    database.prepare(`
      UPDATE provider_dispatch_attempts
      SET status = 'dispatched', dispatched_at = COALESCE(dispatched_at, ?), updated_at = ?
      WHERE id = ? AND status = 'reserved'
    `).run(timestamp, timestamp, attemptId);
    const row = database.prepare(`
      SELECT status, dispatched_at FROM provider_dispatch_attempts WHERE id = ?
    `).get(attemptId) as { status: string; dispatched_at: string | null } | undefined;
    if (row?.status !== "dispatched" || !row.dispatched_at) {
      throw new Error("Provider dispatch boundary was not durably recorded.");
    }
  })();
}

/** Cancel only a reservation proven not to have crossed the network boundary. */
export function cancelUndispatchedProviderReservation(
  attemptId: string,
  outcomeCode = "not_dispatched",
  at: string = new Date().toISOString()
): boolean {
  const timestamp = validIso(at);
  const result = getDb().prepare(`
    UPDATE provider_dispatch_attempts
    SET status = 'cancelled', outcome_code = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'reserved' AND dispatched_at IS NULL
  `).run(outcomeCode, timestamp, timestamp, attemptId);
  return result.changes > 0;
}

function insertUsageOutbox(attemptId: string, outcome: ProviderDispatchOutcome, at: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO provider_usage_outbox (
      id, attempt_id, provider, operation, credential_ref, user_id, outcome,
      requests, estimated_cost_usd, actual_cost_usd, occurred_at, created_at
    )
    SELECT ?, id, provider, operation, credential_ref, user_id, ?, units,
      estimated_cost_usd, actual_cost_usd, COALESCE(dispatched_at, ?), ?
    FROM provider_dispatch_attempts
    WHERE id = ? AND dispatched_at IS NOT NULL
  `).run(`provider-attempt:${attemptId}`, outcome, at, at, attemptId);
}

/**
 * Settle independently of the caller's business lease. A dispatched outcome always creates one
 * idempotent usage-outbox row; Usage Monitor replay can deliver it after any later crash.
 */
export function settleProviderDispatch(
  attemptId: string,
  outcome: ProviderDispatchOutcome,
  options: { outcomeCode?: string; actualCostUsd?: number; at?: string } = {}
): void {
  const timestamp = validIso(options.at);
  const database = getDb();
  database.transaction(() => {
    const updated = database.prepare(`
      UPDATE provider_dispatch_attempts
      SET status = ?, outcome_code = ?, actual_cost_usd = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND dispatched_at IS NOT NULL
        AND status = 'dispatched'
    `).run(
      outcome,
      options.outcomeCode?.slice(0, 120) ?? null,
      typeof options.actualCostUsd === "number" && Number.isFinite(options.actualCostUsd)
        ? Math.max(0, options.actualCostUsd)
        : null,
      timestamp,
      timestamp,
      attemptId
    );
    const row = database.prepare(`
      SELECT status FROM provider_dispatch_attempts WHERE id = ? AND dispatched_at IS NOT NULL
    `).get(attemptId) as { status: string } | undefined;
    if (!row) throw new Error("Provider dispatch outcome has no durable dispatch boundary.");
    if (updated.changes === 1 || row.status === outcome) {
      insertUsageOutbox(attemptId, outcome, timestamp);
    }
  })();
}

/**
 * Recover crash-left states. Never-dispatched stale reservations release quota; dispatched calls
 * become durable `unknown` usage rather than disappearing or being guessed successful/failed.
 */
export function reconcileStaleProviderDispatches(
  now: string = new Date().toISOString(),
  staleAfterMs = 5 * 60_000
): { released: number; unknown: number } {
  const timestamp = validIso(now);
  const cutoff = new Date(Date.parse(timestamp) - Math.max(0, staleAfterMs)).toISOString();
  const database = getDb();
  return database.transaction(() => {
    const released = database.prepare(`
      UPDATE provider_dispatch_attempts
      SET status = 'cancelled', outcome_code = 'stale-undispatched-reservation',
          completed_at = ?, updated_at = ?
      WHERE status = 'reserved' AND dispatched_at IS NULL AND updated_at <= ?
    `).run(timestamp, timestamp, cutoff).changes;
    const rows = database.prepare(`
      SELECT id FROM provider_dispatch_attempts
      WHERE status = 'dispatched' AND dispatched_at IS NOT NULL AND updated_at <= ?
      ORDER BY id
    `).all(cutoff) as Array<{ id: string }>;
    for (const row of rows) {
      database.prepare(`
        UPDATE provider_dispatch_attempts
        SET status = 'unknown', outcome_code = 'process-ended-before-outcome',
            completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'dispatched'
      `).run(timestamp, timestamp, row.id);
      insertUsageOutbox(row.id, "unknown", timestamp);
    }
    return { released, unknown: rows.length };
  })();
}

export interface ProviderUsageOutboxRow {
  id: string;
  attempt_id: string;
  provider: string;
  operation: string;
  credential_ref: string;
  user_id: string;
  outcome: ProviderDispatchOutcome;
  requests: number;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  occurred_at: string;
  created_at: string;
}

export function listProviderUsageOutboxRows(input: {
  after?: { createdAt: string; id: string } | null;
  inclusive?: boolean;
  limit: number;
}): ProviderUsageOutboxRow[] {
  const columns = "id, attempt_id, provider, operation, credential_ref, user_id, outcome, requests, estimated_cost_usd, actual_cost_usd, occurred_at, created_at";
  if (!input.after) {
    return getDb().prepare(`SELECT ${columns} FROM provider_usage_outbox ORDER BY created_at, id LIMIT ?`)
      .all(input.limit) as ProviderUsageOutboxRow[];
  }
  const comparator = input.inclusive ? ">=" : ">";
  return getDb().prepare(`
    SELECT ${columns} FROM provider_usage_outbox
    WHERE created_at > ? OR (created_at = ? AND id ${comparator} ?)
    ORDER BY created_at, id LIMIT ?
  `).all(input.after.createdAt, input.after.createdAt, input.after.id, input.limit) as ProviderUsageOutboxRow[];
}
