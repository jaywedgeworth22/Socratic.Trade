// db-proposals.ts — trade proposal CRUD
import { getDb } from "./db";
import { scopeAccount } from "./db-execution";
import type {
  ExecutionMode,
  PendingProposal,
  PolicyDecision,
  ReviewedOrder,
  TradeProposal
} from "./types";

export function listPendingProposals(accountNumber: string, userId: string = "local"): PendingProposal[] {
  type RawRow = {
    id: string;
    created_at: string;
    proposal: string;
    decision: string;
    review: string | null;
    estimated_notional: number | null;
    last_revalidated_at: string | null;
    revalidation_note: string | null;
    account_number: string;
    execution_mode: string | null;
  };
  const rows = getDb()
    .prepare(
      "SELECT id, created_at, proposal, decision, review, estimated_notional, last_revalidated_at, revalidation_note, account_number, execution_mode FROM trade_proposals WHERE account_number = ? AND user_id = ? AND status = 'proposed' ORDER BY created_at DESC"
    )
    .all(scopeAccount(accountNumber), userId) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    proposal: JSON.parse(r.proposal) as TradeProposal,
    decision: JSON.parse(r.decision) as PolicyDecision,
    review: r.review ? (JSON.parse(r.review) as ReviewedOrder) : undefined,
    estimatedNotional: r.estimated_notional ?? undefined,
    lastRevalidatedAt: r.last_revalidated_at ?? undefined,
    revalidationNote: r.revalidation_note ?? undefined,
    accountNumber: r.account_number,
    executionMode: r.execution_mode ? (r.execution_mode as ExecutionMode) : undefined
  }));
}

/**
 * Stamp a still-pending proposal as re-validated by a strategy run's LLM "does this still
 * stand?" pass. Only touches the staleness columns — status stays "proposed".
 */
export function markProposalRevalidated(
  id: string,
  input: { at: string; note?: string },
  userId: string = "local"
): void {
  getDb()
    .prepare(
      "UPDATE trade_proposals SET last_revalidated_at = ?, revalidation_note = COALESCE(?, revalidation_note) WHERE id = ? AND user_id = ? AND status = 'proposed'"
    )
    .run(input.at, input.note ?? null, id, userId);
}

export function getProposal(id: string, userId: string = "local"):
  | {
      id: string;
      runId: string;
      accountNumber: string;
      createdAt: string;
      proposal: TradeProposal;
      decision: PolicyDecision;
      review?: ReviewedOrder;
      estimatedNotional?: number;
      status: string;
      tradeThesisTag?: string;
      entryMarketRegime?: string;
      executionMode?: ExecutionMode;
    }
  | undefined {
  type RawRow = {
    id: string;
    run_id: string;
    account_number: string;
    created_at: string;
    proposal: string;
    decision: string;
    review: string | null;
    estimated_notional: number | null;
    status: string;
    trade_thesis_tag: string | null;
    entry_market_regime: string | null;
    execution_mode: string | null;
  };
  const row = getDb()
    .prepare("SELECT id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, status, trade_thesis_tag, entry_market_regime, execution_mode FROM trade_proposals WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    runId: row.run_id,
    accountNumber: row.account_number,
    createdAt: row.created_at,
    proposal: JSON.parse(row.proposal) as TradeProposal,
    decision: JSON.parse(row.decision) as PolicyDecision,
    review: row.review ? (JSON.parse(row.review) as ReviewedOrder) : undefined,
    estimatedNotional: row.estimated_notional ?? undefined,
    status: row.status,
    tradeThesisTag: row.trade_thesis_tag ?? undefined,
    entryMarketRegime: row.entry_market_regime ?? undefined,
    executionMode: row.execution_mode ? (row.execution_mode as ExecutionMode) : undefined
  };
}

export function updateProposalStatus(id: string, status: string, orderId?: string, review?: ReviewedOrder, estimatedNotional?: number, userId: string = "local", refId?: string): void {
  getDb()
    .prepare(
      "UPDATE trade_proposals SET status = ?, order_id = COALESCE(?, order_id), review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional), ref_id = COALESCE(?, ref_id) WHERE id = ? AND user_id = ?"
    )
    .run(status, orderId ?? null, review ? JSON.stringify(review) : null, estimatedNotional ?? null, refId ?? null, id, userId);
}

/**
 * Atomic compare-and-swap claim of a still-pending proposal for execution.
 * Transitions status 'proposed' -> `toStatus` in a single synchronous UPDATE and
 * returns true ONLY for the caller that won the race. This is the guard that
 * prevents two concurrent approvals (double-click, two tabs, the from-draft flow,
 * or a scheduled run racing a manual approve) from both reaching placeEquityOrder
 * and doubling a real position. better-sqlite3 statements are synchronous and
 * atomic, so exactly one concurrent caller sees `changes === 1`.
 */
export function claimProposalForExecution(
  id: string,
  toStatus: string,
  userId: string = "local",
  opts: { review?: ReviewedOrder; estimatedNotional?: number; refId?: string; executionMode?: ExecutionMode } = {}
): boolean {
  const info = getDb()
    .prepare(
      "UPDATE trade_proposals SET status = ?, review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional), ref_id = COALESCE(?, ref_id), execution_mode = COALESCE(?, execution_mode) WHERE id = ? AND user_id = ? AND status = 'proposed'"
    )
    .run(
      toStatus,
      opts.review ? JSON.stringify(opts.review) : null,
      opts.estimatedNotional ?? null,
      opts.refId ?? null,
      opts.executionMode ?? null,
      id,
      userId
    );
  return info.changes === 1;
}

/**
 * Crash-recovery support: "placing" rows older than the cutoff. A "placing" row is an
 * order-placement INTENT written just before the broker call; it normally flips to "placed"
 * (or "placing_failed") synchronously. One that lingers means a prior run died mid-placement,
 * so the order's true state is unknown and must be surfaced for reconciliation.
 */
export function listStalePlacingProposals(
  accountNumber: string,
  olderThanIso: string,
  userId: string = "local"
): Array<{ id: string; refId: string | null; proposal: unknown; createdAt: string; executionMode?: ExecutionMode }> {
  const rows = getDb()
    .prepare(
      "SELECT id, ref_id as refId, proposal, created_at as createdAt, execution_mode as executionMode FROM trade_proposals WHERE account_number = ? AND user_id = ? AND status = 'placing' AND created_at < ?"
    )
    .all(scopeAccount(accountNumber), userId, olderThanIso) as Array<{ id: string; refId: string | null; proposal: string; createdAt: string; executionMode: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    refId: r.refId,
    proposal: JSON.parse(r.proposal),
    createdAt: r.createdAt,
    executionMode: r.executionMode ? (r.executionMode as ExecutionMode) : undefined
  }));
}

/** Idempotency for chat-drafted proposals: the id of an existing still-`proposed` row for a runId. */
export function findProposedIdByRunId(runId: string, userId: string = "local"): string | null {
  const row = getDb()
    .prepare("SELECT id FROM trade_proposals WHERE run_id = ? AND user_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1")
    .get(runId, userId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function insertProposal(input: {
  userId?: string;
  id: string;
  runId: string;
  accountNumber: string;
  proposal: unknown;
  decision: unknown;
  review?: unknown;
  estimatedNotional?: number;
  refId?: string;
  orderId?: string;
  status: string;
  tradeThesisTag?: string;
  entryMarketRegime?: string;
  executionMode?: ExecutionMode;
}): void {
  getDb()
    .prepare(
      "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, ref_id, order_id, status, trade_thesis_tag, entry_market_regime, execution_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.id,
      input.userId ?? "local",
      input.runId,
      scopeAccount(input.accountNumber),
      new Date().toISOString(),
      JSON.stringify(input.proposal),
      JSON.stringify(input.decision),
      input.review ? JSON.stringify(input.review) : null,
      input.estimatedNotional ?? null,
      input.refId ?? null,
      input.orderId ?? null,
      input.status,
      input.tradeThesisTag ?? null,
      input.entryMarketRegime ?? null,
      input.executionMode ?? null
    );
}
