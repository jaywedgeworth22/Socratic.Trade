// db-fills.ts — fill events, portfolio snapshots, excursions
import crypto from "crypto";
import { getDb } from "./db";
import type {
  ExecutionMode,
  FillEvent,
  FillSource,
  PortfolioSnapshot
} from "./types";

// ── Raw-row types ──────────────────────────────────────────────────────────────

type RawPortfolioSnapshot = {
  id: string;
  run_id: string | null;
  account_number: string;
  source: string;
  equity: number;
  cash: number;
  buying_power: number;
  positions_value: number;
  positions: string;
  created_at: string;
  execution_mode: string | null;
};

type RawFillEvent = {
  id: string;
  proposal_id: string | null;
  run_id: string | null;
  account_number: string;
  source: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  notional: number;
  status: string;
  broker_order_id: string | null;
  raw: string | null;
  mae: number | null;
  mfe: number | null;
  filled_at: string;
  execution_mode: string | null;
};

// ── Mapper functions ──────────────────────────────────────────────────────────

function toPortfolioSnapshot(row: RawPortfolioSnapshot): PortfolioSnapshot {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    accountNumber: row.account_number,
    source: row.source as FillSource,
    equity: row.equity,
    cash: row.cash,
    buyingPower: row.buying_power,
    positionsValue: row.positions_value,
    positions: JSON.parse(row.positions),
    createdAt: row.created_at,
    executionMode: row.execution_mode ? (row.execution_mode as ExecutionMode) : undefined
  };
}

function toFillEvent(row: RawFillEvent): FillEvent {
  return {
    id: row.id,
    proposalId: row.proposal_id ?? undefined,
    runId: row.run_id ?? undefined,
    accountNumber: row.account_number,
    source: row.source as FillSource,
    symbol: row.symbol,
    side: row.side as FillEvent["side"],
    quantity: row.quantity,
    price: row.price,
    notional: row.notional,
    status: row.status,
    brokerOrderId: row.broker_order_id ?? undefined,
    raw: row.raw ? JSON.parse(row.raw) : undefined,
    mae: row.mae ?? undefined,
    mfe: row.mfe ?? undefined,
    filledAt: row.filled_at,
    executionMode: row.execution_mode ? (row.execution_mode as ExecutionMode) : undefined
  };
}

// ── Portfolio snapshots ────────────────────────────────────────────────────────

export function insertPortfolioSnapshot(input: {
  userId?: string;
  id?: string;
  runId?: string;
  accountNumber: string;
  source: FillSource;
  executionMode?: ExecutionMode;
  equity: number;
  cash: number;
  buyingPower: number;
  positionsValue: number;
  positions: unknown;
  createdAt?: string;
}): PortfolioSnapshot {
  const snapshot: PortfolioSnapshot = {
    id: input.id ?? crypto.randomUUID(),
    runId: input.runId,
    accountNumber: input.accountNumber,
    source: input.source,
    equity: input.equity,
    cash: input.cash,
    buyingPower: input.buyingPower,
    positionsValue: input.positionsValue,
    positions: input.positions as PortfolioSnapshot["positions"],
    createdAt: input.createdAt ?? new Date().toISOString(),
    executionMode: input.executionMode
  };
  getDb()
    .prepare(
      "INSERT INTO portfolio_snapshots (id, user_id, run_id, account_number, source, execution_mode, equity, cash, buying_power, positions_value, positions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      snapshot.id,
      input.userId ?? "local",
      snapshot.runId ?? null,
      snapshot.accountNumber,
      snapshot.source,
      snapshot.executionMode ?? null,
      snapshot.equity,
      snapshot.cash,
      snapshot.buyingPower,
      snapshot.positionsValue,
      JSON.stringify(snapshot.positions),
      snapshot.createdAt
    );
  return snapshot;
}

/**
 * Symbols with a non-zero position in the LATEST portfolio snapshot of every (user, account)
 * pair, restricted to snapshots recent enough to reflect a live account (default 7 days —
 * snapshots are written every strategy run, so an older latest-snapshot means the account
 * isn't actively trading). Broker-call-free holdings read for background producers (e.g. the
 * EarningsCalls.dev transcript selector) that must not spend broker API calls to learn what
 * is held. Returns normalized unique symbols, alphabetical.
 */
export function listRecentlyHeldSymbolsAllUsers(maxAgeDays = 7, now: number = Date.now()): string[] {
  const cutoff = new Date(now - maxAgeDays * 86_400_000).toISOString();
  // SQLite bare-column-with-MAX semantics: with GROUP BY + MAX(created_at), the non-aggregate
  // `positions` column is taken from the row that supplied the MAX — i.e. each group's latest
  // snapshot (documented SQLite behavior for a single MAX/MIN aggregate).
  const rows = getDb()
    .prepare(
      `SELECT positions, MAX(created_at) AS created_at
       FROM portfolio_snapshots
       GROUP BY user_id, account_number
       HAVING MAX(created_at) >= ?`
    )
    .all(cutoff) as Array<{ positions: string }>;
  const symbols = new Set<string>();
  for (const row of rows) {
    try {
      const positions = JSON.parse(row.positions) as Array<{ symbol?: unknown; quantity?: unknown }>;
      if (!Array.isArray(positions)) continue;
      for (const position of positions) {
        const symbol = typeof position?.symbol === "string" ? position.symbol.trim().toUpperCase() : "";
        const quantity = typeof position?.quantity === "number" ? position.quantity : 0;
        if (symbol && quantity !== 0) symbols.add(symbol);
      }
    } catch {
      // A single malformed snapshot must not break the holdings read.
    }
  }
  return [...symbols].sort();
}

export function listPortfolioSnapshots(accountNumber: string, source?: FillSource, limit = 100, userId: string = "local"): PortfolioSnapshot[] {
  const rows = source
    ? (getDb()
        .prepare("SELECT * FROM portfolio_snapshots WHERE account_number = ? AND source = ? AND user_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(accountNumber, source, userId, limit) as RawPortfolioSnapshot[])
    : (getDb()
        .prepare("SELECT * FROM portfolio_snapshots WHERE account_number = ? AND user_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(accountNumber, userId, limit) as RawPortfolioSnapshot[]);
  return rows.map(toPortfolioSnapshot);
}

// ── Fill events ────────────────────────────────────────────────────────────────

export function insertFillEvent(input: Omit<FillEvent, "id" | "filledAt"> & { id?: string; filledAt?: string; userId?: string }): FillEvent {
  const userId = input.userId ?? "local";
  const fill: FillEvent = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    filledAt: input.filledAt ?? new Date().toISOString()
  };
  try {
    getDb()
      .prepare(
        "INSERT INTO fill_events (id, user_id, proposal_id, run_id, account_number, source, execution_mode, symbol, side, quantity, price, notional, status, broker_order_id, raw, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        fill.id,
        userId,
        fill.proposalId ?? null,
        fill.runId ?? null,
        fill.accountNumber,
        fill.source,
        fill.executionMode ?? null,
        fill.symbol,
        fill.side,
        fill.quantity,
        fill.price,
        fill.notional,
        fill.status,
        fill.brokerOrderId ?? null,
        fill.raw === undefined ? null : JSON.stringify(fill.raw),
        fill.filledAt
      );
  } catch (e) {
    // Durable double-fill backstop (migration 16's partial UNIQUE index on
    // (proposal_id, broker_order_id)). A second insert of the SAME physical broker order for the
    // same proposal is an idempotent no-op — return the already-booked fill rather than throwing or
    // double-booking, even if the single-process dedupe guard was somehow bypassed (concurrent
    // processes). Only intercept the specific unique-constraint case; anything else re-throws.
    if (isUniqueConstraintError(e) && fill.proposalId && fill.brokerOrderId) {
      const existing = getDb()
        .prepare(
          "SELECT * FROM fill_events WHERE proposal_id = ? AND broker_order_id = ? AND user_id = ? ORDER BY filled_at ASC LIMIT 1"
        )
        .get(fill.proposalId, fill.brokerOrderId, userId) as RawFillEvent | undefined;
      if (existing) return toFillEvent(existing);
    }
    throw e;
  }
  return fill;
}

/** better-sqlite3 surfaces a UNIQUE-index violation as SqliteError code SQLITE_CONSTRAINT_UNIQUE. */
function isUniqueConstraintError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && code.includes("SQLITE_CONSTRAINT");
}

export function listFillEvents(accountNumber: string, source?: FillSource, limit = 500, userId: string = "local"): FillEvent[] {
  const rows = source
    ? (getDb()
        .prepare("SELECT * FROM fill_events WHERE account_number = ? AND source = ? AND user_id = ? ORDER BY filled_at ASC LIMIT ?")
        .all(accountNumber, source, userId, limit) as RawFillEvent[])
    : (getDb()
        .prepare("SELECT * FROM fill_events WHERE account_number = ? AND user_id = ? ORDER BY filled_at ASC LIMIT ?")
        .all(accountNumber, userId, limit) as RawFillEvent[]);
  return rows.map(toFillEvent);
}

/** Fills for one proposal (entry-basis lookup for the outcome engine's placed-decision join). */
export function listFillEventsByProposalId(proposalId: string, userId: string = "local"): FillEvent[] {
  const rows = getDb()
    .prepare("SELECT * FROM fill_events WHERE proposal_id = ? AND user_id = ? ORDER BY filled_at ASC")
    .all(proposalId, userId) as RawFillEvent[];
  return rows.map(toFillEvent);
}

export function listPendingBrokerReconciliationFills(accountNumber: string, userId: string = "local"): FillEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM fill_events
       WHERE account_number = ?
         AND user_id = ?
         AND status IN ('pending_reconciliation', 'partially_filled')
         AND broker_order_id IS NOT NULL
         AND (source = 'live' OR execution_mode IN ('broker/paper', 'broker/live'))
       ORDER BY filled_at ASC`
    )
    .all(accountNumber, userId) as RawFillEvent[];
  return rows.map(toFillEvent);
}

/** Signed net position quantity implied by ACCOUNTING fills (filled/partially_filled) for one
 *  symbol — buy/cover add, sell/short subtract. Used by reconciliation's absent-order escalation
 *  as DIAGNOSTIC evidence (broker position vs booked net) — never to flip a fill: fill_events is
 *  not a complete ledger of the broker account (manual/MCP trades and pre-app holdings exist), so
 *  a matching position delta is not proof the app's order executed. */
export function netAccountingFillQuantity(accountNumber: string, source: FillSource, symbol: string, userId: string = "local"): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN side IN ('buy', 'cover') THEN quantity ELSE -quantity END), 0) AS net
       FROM fill_events
       WHERE account_number = ? AND source = ? AND symbol = ? AND user_id = ?
         AND status IN ('filled', 'partially_filled')`
    )
    .get(accountNumber, source, symbol, userId) as { net: number };
  return row.net;
}

export function updateFillEvent(id: string, patch: Partial<FillEvent>, userId: string = "local"): void {
  const database = getDb();
  const sets: string[] = [];
  const args: unknown[] = [];

  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.price !== undefined) {
    sets.push("price = ?");
    args.push(patch.price);
  }
  if (patch.quantity !== undefined) {
    sets.push("quantity = ?");
    args.push(patch.quantity);
  }
  if (patch.notional !== undefined) {
    sets.push("notional = ?");
    args.push(patch.notional);
  }
  if (patch.raw !== undefined) {
    sets.push("raw = ?");
    args.push(patch.raw === null ? null : JSON.stringify(patch.raw));
  }
  if (patch.filledAt !== undefined) {
    sets.push("filled_at = ?");
    args.push(patch.filledAt);
  }

  if (sets.length === 0) return;

  args.push(id, userId);
  database.prepare(`UPDATE fill_events SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...args);
}

/**
 * Persist MAE/MFE excursion values for a fill event by id.
 * Additive only — never touches other columns.
 */
export function upsertFillExcursions(
  id: string,
  mae: number,
  mfe: number,
  userId: string = "local"
): void {
  getDb()
    .prepare("UPDATE fill_events SET mae = ?, mfe = ? WHERE id = ? AND user_id = ?")
    .run(mae, mfe, id, userId);
}

/**
 * Persist MAE/MFE excursion values for a fill event matched by
 * (accountNumber, symbol, filledAt). Used when only the lot's exit context
 * (symbol + exitAt) is available, not the raw fill id. Additive only.
 */
export function upsertFillExcursionsByKey(
  accountNumber: string,
  symbol: string,
  filledAt: string,
  mae: number,
  mfe: number,
  userId: string = "local"
): void {
  getDb()
    .prepare(
      "UPDATE fill_events SET mae = ?, mfe = ? WHERE account_number = ? AND symbol = ? AND filled_at = ? AND user_id = ?"
    )
    .run(mae, mfe, accountNumber, symbol, filledAt, userId);
}
