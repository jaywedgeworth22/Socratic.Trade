/**
 * db-learning.ts — Audit log helpers and counterfactual learning functions.
 * Extracted from db.ts. All DB access goes through getDb() from "./db".
 */

import { getDb } from "./db";

// ── Audit helpers ─────────────────────────────────────────────────────────────

export function listAudit(limit = 100, userId: string = "local"): Array<{ id: string; createdAt: string; kind: string; payload: unknown }> {
  const rows = getDb()
    .prepare("SELECT id, created_at, kind, payload FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as Array<{ id: string; created_at: string; kind: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload)
  }));
}

export function latestAuditByKind(kind: string, userId: string = "local"): { id: string; createdAt: string; kind: string; payload: unknown } | undefined {
  const row = getDb()
    .prepare("SELECT id, created_at, kind, payload FROM audit_events WHERE kind = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(kind, userId) as { id: string; created_at: string; kind: string; payload: string } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload)
  };
}

// ── Counterfactual learning watermark ─────────────────────────────────────────

export interface SignalSnapshotAuditRow {
  rowid: number;
  id: string;
  createdAt: string;
  payload: unknown;
}

export interface CounterfactualLearningWatermark {
  userId: string;
  lastAuditRowid?: number;
  lastAuditCreatedAt?: string;
  lastAuditId?: string;
  updatedAt: string;
}

export function getCounterfactualLearningWatermark(userId: string = "local"): CounterfactualLearningWatermark | undefined {
  const row = getDb()
    .prepare("SELECT user_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at FROM counterfactual_learning_watermarks WHERE user_id = ?")
    .get(userId) as { user_id: string; last_audit_rowid: number | null; last_audit_created_at: string | null; last_audit_id: string | null; updated_at: string } | undefined;
  if (!row) return undefined;
  return {
    userId: row.user_id,
    lastAuditRowid: row.last_audit_rowid ?? undefined,
    lastAuditCreatedAt: row.last_audit_created_at ?? undefined,
    lastAuditId: row.last_audit_id ?? undefined,
    updatedAt: row.updated_at
  };
}

export function setCounterfactualLearningWatermark(input: {
  userId?: string;
  lastAuditRowid?: number;
  lastAuditCreatedAt?: string;
  lastAuditId?: string;
  updatedAt?: string;
}): void {
  const userId = input.userId ?? "local";
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO counterfactual_learning_watermarks (user_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
        last_audit_rowid = excluded.last_audit_rowid,
        last_audit_created_at = excluded.last_audit_created_at,
        last_audit_id = excluded.last_audit_id,
        updated_at = excluded.updated_at`
    )
    .run(userId, input.lastAuditRowid ?? null, input.lastAuditCreatedAt ?? null, input.lastAuditId ?? null, updatedAt);
}

export function listSignalSnapshotAuditAfter(
  userId: string = "local",
  watermark?: { lastAuditRowid?: number },
  limit = 100
): SignalSnapshotAuditRow[] {
  const hasWatermark = typeof watermark?.lastAuditRowid === "number";
  const rows = hasWatermark
    ? (getDb()
        .prepare(
          `SELECT rowid, id, created_at, payload
           FROM audit_events
           WHERE user_id = ?
            AND kind = 'signal_snapshot'
            AND rowid > ?
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(userId, watermark!.lastAuditRowid, limit) as Array<{ rowid: number; id: string; created_at: string; payload: string }>)
    : (getDb()
        .prepare(
          `SELECT rowid, id, created_at, payload
           FROM audit_events
           WHERE user_id = ? AND kind = 'signal_snapshot'
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(userId, limit) as Array<{ rowid: number; id: string; created_at: string; payload: string }>);

  return rows.map((row) => ({ rowid: row.rowid, id: row.id, createdAt: row.created_at, payload: JSON.parse(row.payload) }));
}

// ── Skipped counterfactual candidates ─────────────────────────────────────────

export interface SkippedCounterfactualCandidateInput {
  userId?: string;
  runId: string;
  symbol: string;
  snapshotAt: string;
  refPrice: number;
  horizonDays: number;
  targetDate: string;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  bulletins?: string[];
  now?: string;
}

export interface SkippedCounterfactualRow {
  id: string;
  userId: string;
  runId: string;
  symbol: string;
  snapshotAt: string;
  refPrice: number;
  horizonDays: number;
  targetDate: string;
  status: "pending" | "matured";
  exitDate?: string;
  exitPrice?: number;
  returnPct?: number;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  bulletins?: string[];
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

type RawSkippedCounterfactualRow = {
  id: string;
  user_id: string;
  run_id: string;
  symbol: string;
  snapshot_at: string;
  ref_price: number;
  horizon_days: number;
  target_date: string;
  status: string;
  exit_date: string | null;
  exit_price: number | null;
  return_pct: number | null;
  score: number | null;
  sector: string | null;
  regime: string | null;
  dominant_factor: string | null;
  bulletins: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

function toSkippedCounterfactualRow(row: RawSkippedCounterfactualRow): SkippedCounterfactualRow {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    symbol: row.symbol,
    snapshotAt: row.snapshot_at,
    refPrice: row.ref_price,
    horizonDays: row.horizon_days,
    targetDate: row.target_date,
    status: row.status === "matured" ? "matured" : "pending",
    exitDate: row.exit_date ?? undefined,
    exitPrice: row.exit_price ?? undefined,
    returnPct: row.return_pct ?? undefined,
    score: row.score ?? undefined,
    sector: row.sector ?? undefined,
    regime: row.regime ?? undefined,
    dominantFactor: row.dominant_factor ?? undefined,
    bulletins: row.bulletins ? JSON.parse(row.bulletins) as string[] : undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function insertSkippedCounterfactualCandidate(input: SkippedCounterfactualCandidateInput): boolean {
  const userId = input.userId ?? "local";
  const now = input.now ?? new Date().toISOString();
  const id = `${userId}:${input.runId}:${input.symbol}:${input.horizonDays}`;
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO skipped_candidate_counterfactuals (
        id, user_id, run_id, symbol, snapshot_at, ref_price, horizon_days,
        target_date, status, score, sector, regime, dominant_factor, bulletins,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.runId,
      input.symbol,
      input.snapshotAt,
      input.refPrice,
      input.horizonDays,
      input.targetDate,
      input.score ?? null,
      input.sector ?? null,
      input.regime ?? null,
      input.dominantFactor ?? null,
      input.bulletins ? JSON.stringify(input.bulletins) : null,
      now,
      now
    );
  return result.changes > 0;
}

export function listPendingSkippedCounterfactuals(input: {
  userId?: string;
  nowDate: string;
  checkedBefore?: string;
  limit?: number;
}): SkippedCounterfactualRow[] {
  const userId = input.userId ?? "local";
  const limit = input.limit ?? 50;
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM skipped_candidate_counterfactuals
       WHERE user_id = ?
        AND status = 'pending'
        AND target_date <= ?
        AND (last_checked_at IS NULL OR last_checked_at <= ?)
       ORDER BY target_date ASC, snapshot_at ASC, symbol ASC
       LIMIT ?`
    )
    .all(userId, input.nowDate, input.checkedBefore ?? new Date(0).toISOString(), limit) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

export function markSkippedCounterfactualChecked(id: string, userId: string = "local", checkedAt: string = new Date().toISOString()): void {
  getDb()
    .prepare("UPDATE skipped_candidate_counterfactuals SET last_checked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(checkedAt, checkedAt, id, userId);
}

export function markSkippedCounterfactualMatured(input: {
  id: string;
  userId?: string;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
  checkedAt?: string;
}): boolean {
  const userId = input.userId ?? "local";
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE skipped_candidate_counterfactuals
       SET status = 'matured',
        exit_date = ?,
        exit_price = ?,
        return_pct = ?,
        last_checked_at = ?,
        updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(input.exitDate, input.exitPrice, input.returnPct, checkedAt, checkedAt, input.id, userId);
  return result.changes > 0;
}

export function listMaturedSkippedCounterfactuals(userId: string = "local", limit = 50): SkippedCounterfactualRow[] {
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM skipped_candidate_counterfactuals
       WHERE user_id = ? AND status = 'matured'
       ORDER BY return_pct DESC, updated_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}
