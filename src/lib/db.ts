import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import crypto from "crypto";
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
  TradeProposal,
  ConnectedAccount
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
      status TEXT NOT NULL,
      trade_thesis_tag TEXT,
      entry_market_regime TEXT
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

    -- Multi-user API key storage (scaffolding for future multi-user support)
    CREATE TABLE IF NOT EXISTS user_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      service TEXT NOT NULL,
      api_key TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, service)
    );
    CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys (user_id);

    -- Multi-account storage
    CREATE TABLE IF NOT EXISTS connected_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      broker TEXT NOT NULL,
      environment TEXT NOT NULL,
      account_number TEXT,
      label TEXT NOT NULL,
      api_key TEXT,
      api_secret TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts (user_id);

    -- Multi-user settings
    CREATE TABLE IF NOT EXISTS user_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, key)
    );
  `);

  // Migrate tables to include user_id
  const tablesWithUserId = [
    "strategy_runs",
    "trade_proposals",
    "strategy_profiles",
    "portfolio_snapshots",
    "fill_events",
    "notification_events",
    "audit_events"
  ];
  for (const table of tablesWithUserId) {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "user_id")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local'`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table} (user_id)`);
    }
  }

  const columns = database.prepare("PRAGMA table_info(trade_proposals)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "account_number")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN account_number TEXT NOT NULL DEFAULT ''");
  }
  // Phase 2: persist the reviewed estimated notional so daily accounting is accurate
  // for share-qty market orders (which have no limitPrice to derive notional from).
  if (!columns.some((column) => column.name === "estimated_notional")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN estimated_notional REAL");
  }
  // Phase 7: persist thesis tags for learning loop
  if (!columns.some((column) => column.name === "trade_thesis_tag")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN trade_thesis_tag TEXT");
    database.exec("ALTER TABLE trade_proposals ADD COLUMN entry_market_regime TEXT");
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
  const userId = "local";
  const existing = database.prepare("SELECT COUNT(*) AS count FROM strategy_profiles WHERE user_id = ?").get(userId) as { count: number };
  if (existing.count === 0) {
    const policyRow = database.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string } | undefined;
    const promptRow = database.prepare("SELECT value FROM settings WHERE key = 'strategyPrompt'").get() as { value: string } | undefined;
    const rawPolicy = policyRow?.value ?? JSON.stringify(DEFAULT_POLICY);
    const policy = mergePolicy(JSON.parse(rawPolicy) as Partial<TradingPolicy>);
    const prompt = promptRow ? (JSON.parse(promptRow.value) as string) : DEFAULT_STRATEGY_PROMPT;
    database
      .prepare(
        "INSERT INTO strategy_profiles (id, user_id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("default", userId, "Default Strategy", JSON.stringify(policy), prompt, JSON.stringify(policy.scoringWeights), 1, now, now);
    return;
  }

  const active = database.prepare("SELECT id FROM strategy_profiles WHERE user_id = ? AND active = 1 LIMIT 1").get(userId);
  if (!active) {
    database.prepare("UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = (SELECT id FROM strategy_profiles WHERE user_id = ? ORDER BY created_at LIMIT 1)").run(now, userId);
  }
}

export function getUserSetting<T>(userId: string, key: string, fallback: T): T {
  const row = getDb().prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return row.value as T; }
}

export function setUserSetting(userId: string, key: string, value: unknown): void {
  const id = `${userId}_${key}`;
  getDb().prepare(
    "INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(id, userId, key, JSON.stringify(value), new Date().toISOString());
  audit("policy_change", { userId, key, value }, userId);
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



export function getPolicy(userId: string = "local"): TradingPolicy {
  let policy: TradingPolicy;
  const active = getActiveStrategyProfile(userId);
  if (active) policy = mergePolicy({ ...active.policy, activeProfileId: active.id });
  else policy = mergePolicy(getUserSetting(userId, "policy", DEFAULT_POLICY));

  const activeAccount = getActiveConnectedAccount(userId);
  if (activeAccount) {
    policy.connectedAccountId = activeAccount.id;
    policy.activeBroker = activeAccount.broker;
    policy.paperMode = activeAccount.environment === "paper";
    policy.accountNumber = activeAccount.accountNumber;
  }
  
  return policy;
}

export function setPolicy(policy: TradingPolicy, userId: string = "local"): void {
  const merged = mergePolicy(policy);
  setUserSetting(userId, "policy", merged);
  syncActiveProfile({ policy: merged, scoringWeights: merged.scoringWeights }, userId);
}

export function getStrategyPrompt(userId: string = "local"): string {
  return getActiveStrategyProfile(userId)?.prompt ?? getUserSetting(userId, "strategyPrompt", DEFAULT_STRATEGY_PROMPT);
}

export function setStrategyPrompt(prompt: string, userId: string = "local"): void {
  setUserSetting(userId, "strategyPrompt", prompt);
  syncActiveProfile({ prompt }, userId);
}

export function audit(kind: string, payload: unknown, userId: string = "local"): void {
  getDb()
    .prepare("INSERT INTO audit_events (id, user_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), userId, new Date().toISOString(), kind, JSON.stringify(payload));
}

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

export function listStrategyProfiles(userId: string = "local"): StrategyProfile[] {
  const rows = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE user_id = ? ORDER BY active DESC, name ASC")
    .all(userId) as RawStrategyProfile[];
  return rows.map(toStrategyProfile);
}

export function getActiveStrategyProfile(userId: string = "local"): StrategyProfile | undefined {
  const row = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE active = 1 AND user_id = ? LIMIT 1")
    .get(userId) as RawStrategyProfile | undefined;
  return row ? toStrategyProfile(row) : undefined;
}

export function createStrategyProfile(input: { name: string; policy?: Partial<TradingPolicy>; prompt?: string; active?: boolean }, userId: string = "local"): StrategyProfile {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const currentPolicy = getPolicy(userId);
  const policy = mergePolicy({ ...currentPolicy, ...(input.policy ?? {}), activeProfileId: id });
  const prompt = input.prompt ?? getStrategyPrompt(userId);
  const database = getDb();
  const create = database.transaction(() => {
    if (input.active) database.prepare("UPDATE strategy_profiles SET active = 0, updated_at = ? WHERE user_id = ?").run(now, userId);
    database
      .prepare(
        "INSERT INTO strategy_profiles (id, user_id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, userId, input.name, JSON.stringify(policy), prompt, JSON.stringify(policy.scoringWeights), input.active ? 1 : 0, now, now);
  });
  create();
  if (input.active) {
    setSettingDirect(userId, "policy", policy, now);
    setSettingDirect(userId, "strategyPrompt", prompt, now);
  }
  audit("profile_change", { action: "create", id, name: input.name, active: Boolean(input.active) }, userId);
  return getStrategyProfile(id, userId)!;
}

export function getStrategyProfile(id: string, userId: string = "local"): StrategyProfile | undefined {
  const row = getDb()
    .prepare("SELECT id, name, policy, prompt, scoring_weights, active, created_at, updated_at FROM strategy_profiles WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawStrategyProfile | undefined;
  return row ? toStrategyProfile(row) : undefined;
}

export function updateStrategyProfile(id: string, patch: { name?: string; policy?: Partial<TradingPolicy>; prompt?: string; scoringWeights?: Partial<ScoringWeights> }, userId: string = "local"): StrategyProfile {
  const existing = getStrategyProfile(id, userId);
  if (!existing) throw new Error("Strategy profile not found.");
  const now = new Date().toISOString();
  const scoringWeights = normalizeScoringWeights({ ...existing.scoringWeights, ...(patch.scoringWeights ?? {}) });
  const policy = mergePolicy({ ...existing.policy, ...(patch.policy ?? {}), scoringWeights, activeProfileId: id });
  const prompt = patch.prompt ?? existing.prompt;
  getDb()
    .prepare("UPDATE strategy_profiles SET name = ?, policy = ?, prompt = ?, scoring_weights = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(patch.name ?? existing.name, JSON.stringify(policy), prompt, JSON.stringify(scoringWeights), now, id, userId);
  if (existing.active) {
    setSettingDirect(userId, "policy", policy, now);
    setSettingDirect(userId, "strategyPrompt", prompt, now);
  }
  audit("profile_change", { action: "update", id, name: patch.name ?? existing.name }, userId);
  return getStrategyProfile(id, userId)!;
}

export function activateStrategyProfile(id: string, userId: string = "local"): StrategyProfile {
  const profile = getStrategyProfile(id, userId);
  if (!profile) throw new Error("Strategy profile not found.");
  const now = new Date().toISOString();
  const database = getDb();
  const activate = database.transaction(() => {
    database.prepare("UPDATE strategy_profiles SET active = 0, updated_at = ? WHERE user_id = ?").run(now, userId);
    database.prepare("UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = ? AND user_id = ?").run(now, id, userId);
    setSettingDirect(userId, "policy", mergePolicy({ ...profile.policy, activeProfileId: id }), now);
    setSettingDirect(userId, "strategyPrompt", profile.prompt, now);
  });
  activate();
  audit("profile_change", { action: "activate", id, name: profile.name }, userId);
  return getStrategyProfile(id, userId)!;
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

export function dailyExecutionStats(accountNumber: string, now = new Date(), userId: string = "local"): { orderCount: number; notional: number } {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  // Phase 2 fix: use persisted estimated_notional so share-qty market orders
  // (which have no limitPrice) count correctly against the daily cap.
  const rows = getDb()
    .prepare(
      "SELECT proposal, estimated_notional FROM trade_proposals WHERE created_at >= ? AND account_number = ? AND user_id = ? AND status IN ('placed', 'paper')"
    )
    .all(dayStart.toISOString(), accountNumber, userId) as Array<{ proposal: string; estimated_notional: number | null }>;

  return rows.reduce(
    (acc, row) => {
      const proposal = JSON.parse(row.proposal) as { side?: string; dollarAmount?: number; quantity?: number; limitPrice?: number };
      const isBuy = proposal.side === "buy" || proposal.side === "short";
      // Prefer the persisted estimated_notional; fall back to proposal fields for old rows.
      const notional = isBuy
        ? (row.estimated_notional != null
            ? row.estimated_notional
            : (proposal.dollarAmount ?? (proposal.quantity ?? 0) * (proposal.limitPrice ?? 0)))
        : 0;
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

export function insertStrategyRun(id: string, userId: string = "local"): void {
  getDb()
    .prepare("INSERT INTO strategy_runs (id, user_id, started_at, status) VALUES (?, ?, ?, 'running')")
    .run(id, userId, new Date().toISOString());
}

export function finishStrategyRun(id: string, status: "completed" | "failed", summary: string, userId: string = "local"): void {
  getDb()
    .prepare("UPDATE strategy_runs SET finished_at = ?, status = ?, summary = ? WHERE id = ? AND user_id = ?")
    .run(new Date().toISOString(), status, summary, id, userId);
}

export function listStrategyRuns(limit = 20, userId: string = "local"): StrategyRunRow[] {
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
       WHERE sr.user_id = ?
       GROUP BY sr.id
       ORDER BY sr.started_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as RawRow[];

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

export function listPendingProposals(accountNumber: string, userId: string = "local"): PendingProposal[] {
  type RawRow = { id: string; created_at: string; proposal: string; decision: string; review: string | null };
  const rows = getDb()
    .prepare(
      "SELECT id, created_at, proposal, decision, review FROM trade_proposals WHERE account_number = ? AND user_id = ? AND status = 'proposed' ORDER BY created_at DESC"
    )
    .all(accountNumber, userId) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    proposal: JSON.parse(r.proposal) as TradeProposal,
    decision: JSON.parse(r.decision) as PolicyDecision,
    review: r.review ? (JSON.parse(r.review) as ReviewedOrder) : undefined
  }));
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
  };
  const row = getDb()
    .prepare("SELECT id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, status, trade_thesis_tag, entry_market_regime FROM trade_proposals WHERE id = ? AND user_id = ?")
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
    entryMarketRegime: row.entry_market_regime ?? undefined
  };
}

export function updateProposalStatus(id: string, status: string, orderId?: string, review?: ReviewedOrder, estimatedNotional?: number, userId: string = "local"): void {
  getDb()
    .prepare(
      "UPDATE trade_proposals SET status = ?, order_id = COALESCE(?, order_id), review = COALESCE(?, review), estimated_notional = COALESCE(?, estimated_notional) WHERE id = ? AND user_id = ?"
    )
    .run(status, orderId ?? null, review ? JSON.stringify(review) : null, estimatedNotional ?? null, id, userId);
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
}): void {
  getDb()
    .prepare(
      "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, review, estimated_notional, ref_id, order_id, status, trade_thesis_tag, entry_market_regime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.id,
      input.userId ?? "local",
      input.runId,
      input.accountNumber,
      new Date().toISOString(),
      JSON.stringify(input.proposal),
      JSON.stringify(input.decision),
      input.review ? JSON.stringify(input.review) : null,
      input.estimatedNotional ?? null,
      input.refId ?? null,
      input.orderId ?? null,
      input.status,
      input.tradeThesisTag ?? null,
      input.entryMarketRegime ?? null
    );
}

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

export function insertNotificationEvent(input: {
  userId?: string;
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
    .prepare("INSERT INTO notification_events (id, user_id, created_at, type, title, status, webhook_url, payload, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(event.id, input.userId ?? "local", event.createdAt, event.type, event.title, event.status, event.webhookUrl ?? null, JSON.stringify(event.payload), event.error ?? null);
  return event;
}

export function listNotificationEvents(userId: string = "local", limit: number = 50): NotificationEvent[] {
  const rows = getDb()
    .prepare("SELECT id, created_at, type, title, status, webhook_url, payload, error FROM notification_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as RawNotificationEvent[];
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
  const { dryRun: _legacyDryRun, ...policyWithoutLegacyDryRun } = legacy;
  const merged: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...policyWithoutLegacyDryRun,
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

function syncActiveProfile(patch: { policy?: TradingPolicy; prompt?: string; scoringWeights?: ScoringWeights }, userId: string = "local"): void {
  const active = getActiveStrategyProfile(userId);
  if (!active) return;
  const policy = patch.policy ? mergePolicy({ ...patch.policy, activeProfileId: active.id }) : active.policy;
  const prompt = patch.prompt ?? active.prompt;
  const scoringWeights = patch.scoringWeights ?? policy.scoringWeights;
  getDb()
    .prepare("UPDATE strategy_profiles SET policy = ?, prompt = ?, scoring_weights = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(policy), prompt, JSON.stringify(scoringWeights), new Date().toISOString(), active.id, userId);
}

function setSettingDirect(userId: string, key: string, value: unknown, updatedAt: string): void {
  getDb()
    .prepare(
      "INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(`${userId}_${key}`, userId, key, JSON.stringify(value), updatedAt);
}

// ── Field-Level Encryption ──────────────────────────────────────────────────

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, "hex")
  : crypto.randomBytes(32); // Fallback to memory-only key if not set (keys will be lost on restart!)
const ALGORITHM = "aes-256-gcm";

function encryptValue(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

function decryptValue(encryptedText: string): string {
  try {
    const parts = encryptedText.split(":");
    if (parts.length !== 3) return encryptedText; // Legacy unencrypted fallback
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    console.error("Failed to decrypt field:", e);
    return "";
  }
}

// ── Multi-User API Key Storage ──────────────────────────────────────────────

export interface UserApiKey {
  id: string;
  userId: string;
  service: string;
  apiKey: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export function getUserApiKey(userId: string, service: string): UserApiKey | undefined {
  const row = getDb()
    .prepare("SELECT id, user_id, service, api_key, label, created_at, updated_at FROM user_api_keys WHERE user_id = ? AND service = ?")
    .get(userId, service) as { id: string; user_id: string; service: string; api_key: string; label: string | null; created_at: string; updated_at: string } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    service: row.service,
    apiKey: decryptValue(row.api_key),
    label: row.label ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listUserApiKeys(userId: string): UserApiKey[] {
  const rows = getDb()
    .prepare("SELECT id, user_id, service, api_key, label, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY service")
    .all(userId) as Array<{ id: string; user_id: string; service: string; api_key: string; label: string | null; created_at: string; updated_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    service: row.service,
    apiKey: decryptValue(row.api_key),
    label: row.label ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function upsertUserApiKey(userId: string, service: string, apiKey: string, label?: string): UserApiKey {
  const now = new Date().toISOString();
  const id = `${userId}_${service}`;
  const encryptedKey = encryptValue(apiKey);
  getDb()
    .prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET api_key = excluded.api_key, label = excluded.label, updated_at = excluded.updated_at`
    )
    .run(id, userId, service, encryptedKey, label ?? null, now, now);
  return { id, userId, service, apiKey, label, createdAt: now, updatedAt: now };
}

export function deleteUserApiKey(userId: string, service: string): void {
  getDb()
    .prepare("DELETE FROM user_api_keys WHERE user_id = ? AND service = ?")
    .run(userId, service);
}

export function listConnectedAccounts(userId: string = "local"): ConnectedAccount[] {
  const rows = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as any[];
  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    broker: r.broker,
    environment: r.environment,
    accountNumber: r.account_number ?? undefined,
    label: r.label,
    isActive: r.is_active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

export function getActiveConnectedAccount(userId: string = "local"): ConnectedAccount | undefined {
  const row = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? AND is_active = 1 LIMIT 1")
    .get(userId) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    broker: row.broker,
    environment: row.environment,
    accountNumber: row.account_number ?? undefined,
    label: row.label,
    apiKey: row.api_key ? decryptValue(row.api_key) : undefined,
    apiSecret: row.api_secret ? decryptValue(row.api_secret) : undefined,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function upsertConnectedAccount(account: Omit<ConnectedAccount, "createdAt" | "updatedAt">): void {
  const now = new Date().toISOString();
  const encryptedApiKey = account.apiKey?.trim() ? encryptValue(account.apiKey.trim()) : null;
  const encryptedApiSecret = account.apiSecret?.trim() ? encryptValue(account.apiSecret.trim()) : null;
  const database = getDb();
  database.transaction(() => {
    if (account.isActive) {
      database.prepare("UPDATE connected_accounts SET is_active = 0 WHERE user_id = ?").run(account.userId);
    }
    database
      .prepare(
        `INSERT INTO connected_accounts (id, user_id, broker, environment, account_number, label, api_key, api_secret, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          broker = excluded.broker,
          environment = excluded.environment,
          account_number = excluded.account_number,
          label = excluded.label,
          api_key = COALESCE(excluded.api_key, connected_accounts.api_key),
          api_secret = COALESCE(excluded.api_secret, connected_accounts.api_secret),
          is_active = excluded.is_active,
          updated_at = excluded.updated_at`
      )
      .run(
        account.id,
        account.userId,
        account.broker,
        account.environment,
        account.accountNumber ?? null,
        account.label,
        encryptedApiKey,
        encryptedApiSecret,
        account.isActive ? 1 : 0,
        now,
        now
      );
  })();
}

export function setActiveConnectedAccount(id: string, userId: string = "local"): void {
  const db = getDb();
  db.transaction(() => {
    const exists = db.prepare("SELECT id FROM connected_accounts WHERE id = ? AND user_id = ?").get(id, userId);
    if (!exists) throw new Error("Connected account not found.");
    db.prepare("UPDATE connected_accounts SET is_active = 0 WHERE user_id = ?").run(userId);
    db.prepare("UPDATE connected_accounts SET is_active = 1 WHERE id = ? AND user_id = ?").run(id, userId);
  })();
}

export function deleteConnectedAccount(id: string, userId: string = "local"): void {
  getDb().prepare("DELETE FROM connected_accounts WHERE id = ? AND user_id = ?").run(id, userId);
}

/**
 * Resolves the API key for a given service, checking per-user storage first,
 * then falling back to the environment variable.
 */
export function resolveApiKey(service: string, userId?: string): string | undefined {
  if (userId) {
    const userKey = getUserApiKey(userId, service);
    if (userKey?.apiKey) return userKey.apiKey;
  }
  // Fall back to environment variable
  const envMap: Record<string, string> = {
    finnhub: "FINNHUB_API_KEY",
    fmp: "FMP_API_KEY",
    openai: "OPENAI_API_KEY",
    marketstack: "MARKETSTACK_API_KEY",
    alphavantage: "ALPHAVANTAGE_API_KEY",
    tradier: "TRADIER_API_KEY",
    massive: "MASSIVE_API_KEY",
    massive_s3_endpoint: "MASSIVE_S3_ENDPOINT",
    massive_bucket: "MASSIVE_BUCKET",
    massive_access_key_id: "MASSIVE_ACCESS_KEY_ID",
    massive_secret_access_key: "MASSIVE_SECRET_ACCESS_KEY"
  };
  const envVar = envMap[service.toLowerCase()];
  return envVar ? process.env[envVar] : undefined;
}

export function listUsers(): string[] {
  const rows = getDb().prepare("SELECT DISTINCT user_id FROM user_settings").all() as Array<{ user_id: string }>;
  if (rows.length === 0) return ["local"];
  return rows.map(r => r.user_id);
}
