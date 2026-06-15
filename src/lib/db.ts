import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { DEFAULT_POLICY, DEFAULT_SCORING_WEIGHTS, DEFAULT_STRATEGY_PROMPT } from "./defaults";
import type {
  FillEvent,
  FillSource,
  NotificationEvent,
  NotificationEventType,
  NotificationStatus,
  PendingProposal,
  PolicyDecision,
  PortfolioSnapshot,
  ReviewedOrder,
  ScoringWeights,
  StrategyProfile,
  StrategyRunRow,
  TradingPolicy,
  TradeProposal
} from "./types";

let db: Database.Database | undefined;

function databasePath(): string {
  const value = process.env.DATABASE_URL ?? "file:./data/app.db";
  return resolve(value.replace(/^file:/, ""));
}

export function getDb(): Database.Database {
  if (db) return db;
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS trade_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      created_at TEXT NOT NULL,
      proposal TEXT NOT NULL,
      decision TEXT NOT NULL,
      review TEXT,
      ref_id TEXT,
      order_id TEXT,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      policy TEXT NOT NULL,
      prompt TEXT NOT NULL,
      scoring_weights TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      account_number TEXT NOT NULL,
      source TEXT NOT NULL,
      equity REAL NOT NULL,
      cash REAL NOT NULL,
      buying_power REAL NOT NULL,
      positions_value REAL NOT NULL,
      positions TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fill_events (
      id TEXT PRIMARY KEY,
      proposal_id TEXT,
      run_id TEXT,
      account_number TEXT NOT NULL,
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      notional REAL NOT NULL,
      status TEXT NOT NULL,
      broker_order_id TEXT,
      raw TEXT,
      filled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      webhook_url TEXT,
      payload TEXT NOT NULL,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_account ON portfolio_snapshots (account_number, created_at);
    CREATE INDEX IF NOT EXISTS idx_fill_events_account ON fill_events (account_number, filled_at);
    CREATE INDEX IF NOT EXISTS idx_notification_events_created ON notification_events (created_at);
  `);

  const columns = database.prepare("PRAGMA table_info(trade_proposals)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "account_number")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN account_number TEXT NOT NULL DEFAULT ''");
  }
  // Phase 2: persist the reviewed estimated notional so daily accounting is accurate
  // for share-qty market orders (which have no limitPrice to derive notional from).
  if (!columns.some((column) => column.name === "estimated_notional")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN estimated_notional REAL");
  }
  // Rename: legacy "dry_run" proposal status is now "paper".
  database.exec("UPDATE trade_proposals SET status = 'paper' WHERE status = 'dry_run'");

  const now = new Date().toISOString();
  const ensure = database.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  ensure.run("policy", JSON.stringify(DEFAULT_POLICY), now);
  ensure.run("strategyPrompt", JSON.stringify(DEFAULT_STRATEGY_PROMPT), now);
  ensureDefaultProfile(database, now);
}

function ensureDefaultProfile(database: Database.Database, now: string): void {
  const existing = database.prepare("SELECT COUNT(*) AS count FROM strategy_profiles").get() as { count: number };
  if (existing.count === 0) {
    const policyRow = database.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string } | undefined;
    const promptRow = database.prepare("SELECT value FROM settings WHERE key = 'strategyPrompt'").get() as { value: string } | undefined;
    const rawPolicy = policyRow?.value ?? JSON.stringify(DEFAULT_POLICY);
    const policy = mergePolicy(JSON.parse(rawPolicy) as Partial<TradingPolicy>);
    const prompt = promptRow ? (JSON.parse(promptRow.value) as string) : DEFAULT_STRATEGY_PROMPT;
    database
      .prepare(
        "INSERT INTO strategy_profiles (id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
      )
      .run("default", "Default Strategy", JSON.stringify(policy), prompt, JSON.stringify(policy.scoringWeights), now, now);
    return;
  }

  const active = database.prepare("SELECT id FROM strategy_profiles WHERE active = 1 LIMIT 1").get();
  if (!active) {
    database.prepare("UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = (SELECT id FROM strategy_profiles ORDER BY created_at LIMIT 1)").run(now);
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as T;
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
  audit("policy_change", { key, value });
}

export function getInternalSetting<T>(key: string): T | undefined {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value) as T;
}

export function setInternalSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(key, JSON.stringify(value), new Date().toISOString());
}

export function deleteInternalSetting(key: string): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function getPolicy(): TradingPolicy {
  const active = getActiveStrategyProfile();
  if (active) return mergePolicy({ ...active.policy, activeProfileId: active.id });
  return mergePolicy(getSetting("policy", DEFAULT_POLICY));
}

export function setPolicy(policy: TradingPolicy): void {
  const merged = mergePolicy(policy);
  setSetting("policy", merged);
  syncActiveProfile({ policy: merged, scoringWeights: merged.scoringWeights });
}

export function getStrategyPrompt(): string {
  return getActiveStrategyProfile()?.prompt ?? getSetting("strategyPrompt", DEFAULT_STRATEGY_PROMPT);
}

export function setStrategyPrompt(prompt: string): void {
  setSetting("strategyPrompt", prompt);
  syncActiveProfile({ prompt });
}

export function audit(kind: string, payload: unknown): void {
  getDb()
    .prepare("INSERT INTO audit_events (id, created_at, kind, payload) VALUES (?, ?, ?, ?)")
    .run(crypto.randomUUID(), new Date().toISOString(), kind, JSON.stringify(payload));
}

export function listAudit(limit = 100): Array<{ id: string; createdAt: string; kind: string; payload: unknown }> {
  const rows = getDb()
    .prepare("SELECT id, created_at, kind, payload FROM audit_events ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<{ id: string; created_at: string; kind: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload)
  }));
}

export function listStrategyProfiles(): StrategyProfile[] {
  const rows = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles ORDER BY active DESC, name ASC")
    .all() as RawStrategyProfile[];
  return rows.map(toStrategyProfile);
}

export function getActiveStrategyProfile(): StrategyProfile | undefined {
  const row = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE active = 1 LIMIT 1")
    .get() as RawStrategyProfile | undefined;
  return row ? toStrategyProfile(row) : undefined;
}

export function createStrategyProfile(input: { name: string; policy?: Partial<TradingPolicy>; prompt?: string; active?: boolean }): StrategyProfile {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const currentPolicy = getPolicy();
  const policy = mergePolicy({ ...currentPolicy, ...(input.policy ?? {}), activeProfileId: id });
  const prompt = input.prompt ?? getStrategyPrompt();
  const database = getDb();
  const create = database.transaction(() => {
    if (input.active) database.prepare("UPDATE strategy_profiles SET active = 0, updated_at = ?").run(now);
    database
      .prepare(
        "INSERT INTO strategy_profiles (id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, input.name, JSON.stringify(policy), prompt, JSON.stringify(policy.scoringWeights), input.active ? 1 : 0, now, now);
  });
  create();
  if (input.active) {
    setSettingDirect("policy", policy, now);
    setSettingDirect("strategyPrompt", prompt, now);
  }
  audit("profile_change", { action: "create", id, name: input.name, active: Boolean(input.active) });
  return getStrategyProfile(id)!;
}

export function getStrategyProfile(id: string): StrategyProfile | undefined {
  const row = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE id = ?")
    .get(id) as RawStrategyProfile | undefined;
  return row ? toStrategyProfile(row) : undefined;
}

export function updateStrategyProfile(
  id: string,
  patch: { name?: string; policy?: Partial<TradingPolicy>; prompt?: string; scoringWeights?: Partial<ScoringWeights> }
): StrategyProfile {
  const existing = getStrategyProfile(id);
  if (!existing) throw new Error("Strategy profile not found.");
  const now = new Date().toISOString();
  const scoringWeights = normalizeScoringWeights({ ...existing.scoringWeights, ...(patch.scoringWeights ?? {}) });
  const policy = mergePolicy({ ...existing.policy, ...(patch.policy ?? {}), scoringWeights, activeProfileId: id });
  const prompt = patch.prompt ?? existing.prompt;
  getDb()
    .prepare("UPDATE strategy_profiles SET name = ?, policy = ?, prompt = ?, scoring_weights = ?, updated_at = ? WHERE id = ?")
    .run(patch.name ?? existing.name, JSON.stringify(policy), prompt, JSON.stringify(scoringWeights), now, id);
  if (existing.active) {
    setSettingDirect("policy", policy, now);
    setSettingDirect("strategyPrompt", prompt, now);
  }
  audit("profile_change", { action: "update", id, name: patch.name ?? existing.name });
  return getStrategyProfile(id)!;
}

export function activateStrategyProfile(id: string): StrategyProfile {
  const profile = getStrategyProfile(id);
  if (!profile) throw new Error("Strategy profile not found.");
  const now = new Date().toISOString();
  const database = getDb();
  const activate = database.transaction(() => {
    database.prepare("UPDATE strategy_profiles SET active = 0, updated_at = ?").run(now);
    database.prepare("UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = ?").run(now, id);
    setSettingDirect("policy", mergePolicy({ ...profile.policy, activeProfileId: id }), now);
    setSettingDirect("strategyPrompt", profile.prompt, now);
  });
  activate();
  audit("profile_change", { action: "activate", id, name: profile.name });
  return getStrategyProfile(id)!;
}

export function latestAuditByKind(kind: string): { id: string; createdAt: string; kind: string; payload: unknown } | undefined {
  const row = getDb()
    .prepare("SELECT id, created_at, kind, payload FROM audit_events WHERE kind = ? ORDER BY created_at DESC LIMIT 1")
    .get(kind) as { id: string; created_at: string; kind: string; payload: string } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload)
  };
}

export function dailyExecutionStats(accountNumber: string, now = new Date()): { orderCount: number; notional: number } {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  // Phase 2 fix: use persisted estimated_notional so share-qty market orders
  // (which have no limitPrice) count correctly against the daily cap.
  const rows = getDb()
    .prepare(
      "SELECT proposal, estimated_notional FROM trade_proposals WHERE created_at >= ? AND account_number = ? AND status IN ('placed', 'paper')"
    )
    .all(dayStart.toISOString(), accountNumber) as Array<{ proposal: string; estimated_notional: number | null }>;

  return rows.reduce(
    (acc, row) => {
      const proposal = JSON.parse(row.proposal) as { dollarAmount?: number; quantity?: number; limitPrice?: number };
      // Prefer the persisted estimated_notional; fall back to proposal fields for old rows.
      const notional =
        row.estimated_notional != null
          ? row.estimated_notional
          : (proposal.dollarAmount ?? (proposal.quantity ?? 0) * (proposal.limitPrice ?? 0));
      return { orderCount: acc.orderCount + 1, notional: acc.notional + notional };
    },
    { orderCount: 0, notional: 0 }
  );
}

// ── Run lock ──────────────────────────────────────────────────────────────────
// Uses a direct prepared statement (not setSetting) to avoid noisy policy_change
// audit events.

export function acquireStrategyLock(staleMs = 5 * 60_000, now = new Date()): boolean {
  const database = getDb();
  const acquire = database.transaction(() => {
    const row = database
      .prepare("SELECT value FROM settings WHERE key = 'strategy_run_lock'")
      .get() as { value: string } | undefined;

    if (row) {
      try {
        const { lockedAt } = JSON.parse(row.value) as { lockedAt: string };
        const age = now.getTime() - new Date(lockedAt).getTime();
        if (age < staleMs) return false; // lock is still live
      } catch {
        // malformed lock value — treat as absent and reclaim
      }
    }

    const value = JSON.stringify({ lockedAt: now.toISOString() });
    database
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('strategy_run_lock', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(value, now.toISOString());
    return true;
  });

  return acquire() as boolean;
}

export function releaseStrategyLock(): void {
  getDb().prepare("DELETE FROM settings WHERE key = 'strategy_run_lock'").run();
}

export function insertStrategyRun(id: string): void {
  getDb()
    .prepare("INSERT INTO strategy_runs (id, started_at, status) VALUES (?, ?, 'running')")
    .run(id, new Date().toISOString());
}

export function finishStrategyRun(id: string, status: "completed" | "failed", summary: string): void {
  getDb()
    .prepare("UPDATE strategy_runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?")
    .run(new Date().toISOString(), status, summary, id);
}

export function listStrategyRuns(limit = 20): StrategyRunRow[] {
  type RawRow = {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    summary: string | null;
    placed_count: number;
    paper_count: number;
    blocked_count: number;
    proposed_count: number;
    total_count: number;
  };

  const rows = getDb()
    .prepare(
      `SELECT
        sr.id,
        sr.started_at,
        sr.finished_at,
        sr.status,
        sr.summary,
        COUNT(CASE WHEN tp.status = 'placed'   THEN 1 END) AS placed_count,
        COUNT(CASE WHEN tp.status = 'paper'    THEN 1 END) AS paper_count,
        COUNT(CASE WHEN tp.status = 'blocked'  THEN 1 END) AS blocked_count,
        COUNT(CASE WHEN tp.status = 'proposed' THEN 1 END) AS proposed_count,
        COUNT(tp.id)                                        AS total_count
       FROM strategy_runs sr
       LEFT JOIN trade_proposals tp ON tp.run_id = sr.id
       GROUP BY sr.id
       ORDER BY sr.started_at DESC
       LIMIT ?`
    )
    .all(limit) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    status: r.status as StrategyRunRow["status"],
    summary: r.summary ?? undefined,
    placedCount: r.placed_count,
    paperCount: r.paper_count,
    blockedCount: r.blocked_count,
    proposedCount: r.proposed_count,
    totalCount: r.total_count
  }));
}

export function listPendingProposals(accountNumber: string): PendingProposal[] {
  type RawRow = { id: string; created_at: string; proposal: string; decision: string; review: string | null };
  const rows = getDb()
    .prepare(
      "SELECT id, created_at, proposal, decision, review FROM trade_proposals WHERE account_number = ? AND status = 'proposed' ORDER BY created_at DESC"
    )
    .all(accountNumber) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    proposal: JSON.parse(r.proposal) as TradeProposal,
    decision: JSON.parse(r.decision) as PolicyDecision,
    review: r.review ? (JSON.parse(r.review) as ReviewedOrder) : undefined
  }));
}

export function getProposal(id: string):
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
  };
  const row = getDb()
    .prepare("SELECT id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, status FROM trade_proposals WHERE id = ?")
    .get(id) as RawRow | undefined;
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
    status: row.status
  };
}

export function updateProposalStatus(id: string, status: string, orderId?: string, review?: ReviewedOrder, estimatedNotional?: number): void {
  getDb()
    .prepare(
      "UPDATE trade_proposals SET status = ?, order_id = COALESCE(?, order_id), review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional) WHERE id = ?"
    )
    .run(status, orderId ?? null, review ? JSON.stringify(review) : null, estimatedNotional ?? null, id);
}

export function insertProposal(input: {
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
}): void {
  getDb()
    .prepare(
      "INSERT INTO trade_proposals (id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, ref_id, order_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.id,
      input.runId,
      input.accountNumber,
      new Date().toISOString(),
      JSON.stringify(input.proposal),
      JSON.stringify(input.decision),
      input.review ? JSON.stringify(input.review) : null,
      input.estimatedNotional ?? null,
      input.refId ?? null,
      input.orderId ?? null,
      input.status
    );
}

export function insertPortfolioSnapshot(input: {
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
      "INSERT INTO portfolio_snapshots (id, run_id, account_number, source, equity, cash, buying_power, positions_value, positions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      snapshot.id,
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

export function listPortfolioSnapshots(accountNumber: string, source?: FillSource, limit = 250): PortfolioSnapshot[] {
  const rows = source
    ? (getDb()
        .prepare("SELECT * FROM portfolio_snapshots WHERE account_number = ? AND source = ? ORDER BY created_at ASC LIMIT ?")
        .all(accountNumber, source, limit) as RawPortfolioSnapshot[])
    : (getDb()
        .prepare("SELECT * FROM portfolio_snapshots WHERE account_number = ? ORDER BY created_at ASC LIMIT ?")
        .all(accountNumber, limit) as RawPortfolioSnapshot[]);
  return rows.map(toPortfolioSnapshot);
}

export function insertFillEvent(input: Omit<FillEvent, "id" | "filledAt"> & { id?: string; filledAt?: string }): FillEvent {
  const fill: FillEvent = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    filledAt: input.filledAt ?? new Date().toISOString()
  };
  getDb()
    .prepare(
      "INSERT INTO fill_events (id, proposal_id, run_id, account_number, source, symbol, side, quantity, price, notional, status, broker_order_id, raw, filled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      fill.id,
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

export function listFillEvents(accountNumber: string, source?: FillSource, limit = 500): FillEvent[] {
  const rows = source
    ? (getDb()
        .prepare("SELECT * FROM fill_events WHERE account_number = ? AND source = ? ORDER BY filled_at ASC LIMIT ?")
        .all(accountNumber, source, limit) as RawFillEvent[])
    : (getDb()
        .prepare("SELECT * FROM fill_events WHERE account_number = ? ORDER BY filled_at ASC LIMIT ?")
        .all(accountNumber, limit) as RawFillEvent[]);
  return rows.map(toFillEvent);
}

export function insertNotificationEvent(input: {
  type: NotificationEventType;
  title: string;
  status: NotificationStatus;
  webhookUrl?: string;
  payload: unknown;
  error?: string;
}): NotificationEvent {
  const event: NotificationEvent = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    type: input.type,
    title: input.title,
    status: input.status,
    webhookUrl: input.webhookUrl,
    payload: input.payload,
    error: input.error
  };
  getDb()
    .prepare("INSERT INTO notification_events (id, created_at, type, title, status, webhook_url, payload, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(event.id, event.createdAt, event.type, event.title, event.status, event.webhookUrl ?? null, JSON.stringify(event.payload), event.error ?? null);
  return event;
}

export function listNotificationEvents(limit = 50): NotificationEvent[] {
  const rows = getDb()
    .prepare("SELECT id, created_at, type, title, status, webhook_url, payload, error FROM notification_events ORDER BY created_at DESC LIMIT ?")
    .all(limit) as RawNotificationEvent[];
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    type: row.type as NotificationEventType,
    title: row.title,
    status: row.status as NotificationStatus,
    webhookUrl: row.webhook_url ?? undefined,
    payload: JSON.parse(row.payload),
    error: row.error ?? undefined
  }));
}

type RawStrategyProfile = {
  id: string;
  name: string;
  policy: string;
  prompt: string;
  scoring_weights: string;
  active: number;
  created_at: string;
  updated_at: string;
};

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

type RawNotificationEvent = {
  id: string;
  created_at: string;
  type: string;
  title: string;
  status: string;
  webhook_url: string | null;
  payload: string;
  error: string | null;
};

function toStrategyProfile(row: RawStrategyProfile): StrategyProfile {
  const scoringWeights = normalizeScoringWeights(JSON.parse(row.scoring_weights) as Partial<ScoringWeights>);
  const policy = mergePolicy({ ...(JSON.parse(row.policy) as Partial<TradingPolicy>), scoringWeights, activeProfileId: row.id });
  return {
    id: row.id,
    name: row.name,
    policy,
    prompt: row.prompt,
    scoringWeights,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

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

function mergePolicy(policy: Partial<TradingPolicy>): TradingPolicy {
  // Back-compat shim: older stored policies used `dryRun` instead of `paperMode`.
  const legacy = policy as Partial<TradingPolicy> & { dryRun?: boolean };
  const paperMode = policy.paperMode ?? legacy.dryRun ?? DEFAULT_POLICY.paperMode;
  const merged: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...policy,
    paperMode,
    scoringWeights: normalizeScoringWeights(policy.scoringWeights ?? DEFAULT_POLICY.scoringWeights),
    sectorCaps: policy.sectorCaps ?? DEFAULT_POLICY.sectorCaps,
    riskRules: { ...DEFAULT_POLICY.riskRules, ...(policy.riskRules ?? {}) },
    notificationSettings: {
      ...DEFAULT_POLICY.notificationSettings,
      ...(policy.notificationSettings ?? {}),
      enabledEvents:
        policy.notificationSettings?.enabledEvents ?? DEFAULT_POLICY.notificationSettings.enabledEvents
    }
  };
  if (merged.maxDailyNotional >= 500_000) {
    merged.maxDailyNotional = DEFAULT_POLICY.maxDailyNotional;
    if (merged.maxDailyOrders > DEFAULT_POLICY.maxDailyOrders) merged.maxDailyOrders = DEFAULT_POLICY.maxDailyOrders;
  }
  if (merged.maxOrderNotional > 100) merged.maxOrderNotional = DEFAULT_POLICY.maxOrderNotional;
  return merged;
}

function normalizeScoringWeights(weights: Partial<ScoringWeights>): ScoringWeights {
  return {
    ...DEFAULT_SCORING_WEIGHTS,
    ...Object.fromEntries(
      Object.entries(weights).map(([key, value]) => [key, Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0])
    )
  };
}

function syncActiveProfile(patch: { policy?: TradingPolicy; prompt?: string; scoringWeights?: ScoringWeights }): void {
  const active = getActiveStrategyProfile();
  if (!active) return;
  const policy = patch.policy ? mergePolicy({ ...patch.policy, activeProfileId: active.id }) : active.policy;
  const prompt = patch.prompt ?? active.prompt;
  const scoringWeights = patch.scoringWeights ?? policy.scoringWeights;
  getDb()
    .prepare("UPDATE strategy_profiles SET policy = ?, prompt = ?, scoring_weights = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(policy), prompt, JSON.stringify(scoringWeights), new Date().toISOString(), active.id);
}

function setSettingDirect(key: string, value: unknown, updatedAt: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(key, JSON.stringify(value), updatedAt);
}
