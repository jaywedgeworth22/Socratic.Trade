// db-fills.ts — fill events, portfolio snapshots, excursions
import crypto from "crypto";
import { getDb } from "./db";
import type {
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
  filled_at: string;
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
    createdAt: row.created_at
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
    filledAt: row.filled_at
  };
}

// ── Portfolio snapshots ────────────────────────────────────────────────────────

export function insertPortfolioSnapshot(input: {
  userId?: string;
  id?: string;
  runId?: string;
  accountNumber: string;
  source: FillSource;
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
    createdAt: input.createdAt ?? new Date().toISOString()
  };
  getDb()
    .prepare(
      "INSERT INTO portfolio_snapshots (id, user_id, run_id, account_number, source, equity, cash, buying_power, positions_value, positions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      snapshot.id,
      input.userId ?? "local",
      snapshot.runId ?? null,
      snapshot.accountNumber,
      snapshot.source,
      snapshot.equity,
      snapshot.cash,
      snapshot.buyingPower,
      snapshot.positionsValue,
      JSON.stringify(snapshot.positions),
      snapshot.createdAt
    );
  return snapshot;
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
  const fill: FillEvent = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    filledAt: input.filledAt ?? new Date().toISOString()
  };
  getDb()
    .prepare(
      "INSERT INTO fill_events (id, user_id, proposal_id, run_id, account_number, source, symbol, side, quantity, price, notional, status, broker_order_id, raw, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      fill.id,
      input.userId ?? "local",
      fill.proposalId ?? null,
      fill.runId ?? null,
      fill.accountNumber,
      fill.source,
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
  return fill;
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
