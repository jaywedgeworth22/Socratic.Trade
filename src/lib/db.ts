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
  ConnectedAccount,
  PriceAlert,
  PriceAlertOp,
  PriceAlertStatus,
  WatchlistItem,
  NotifyPrefs,
  NotifyChannelId,
  ChatTurn,
  ChatTurnRole
} from "./types";

let db: Database.Database | undefined;
const SP500_DEFAULT_UNIVERSE_MIGRATION_KEY = "migration:sp500_default_universe:2026-06-19";

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
      taxation_type TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts (user_id);

    -- Synthetic trailing-stop registry (R2). Tracks the high/low watermark + trail settings for
    -- positions whose broker can't host a native trailing stop (e.g. Robinhood MCP). The monitor
    -- computes triggers from this; placing the exit order is a separate, gated step.
    CREATE TABLE IF NOT EXISTS synthetic_trailing_stops (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      entry_price REAL NOT NULL,
      extreme_price REAL NOT NULL,
      trail_percent REAL,
      trail_amount REAL,
      status TEXT NOT NULL DEFAULT 'active',
      last_price REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, account_number, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_synthetic_stops_account ON synthetic_trailing_stops (user_id, account_number);

    -- Multi-user settings
    CREATE TABLE IF NOT EXISTS user_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS skipped_candidate_counterfactuals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      snapshot_at TEXT NOT NULL,
      ref_price REAL NOT NULL,
      horizon_days INTEGER NOT NULL,
      target_date TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_date TEXT,
      exit_price REAL,
      return_pct REAL,
      score REAL,
      sector TEXT,
      regime TEXT,
      dominant_factor TEXT,
      bulletins TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, run_id, symbol, horizon_days)
    );
    CREATE INDEX IF NOT EXISTS idx_skipped_counterfactuals_user_status_target ON skipped_candidate_counterfactuals (user_id, status, target_date);
    CREATE INDEX IF NOT EXISTS idx_skipped_counterfactuals_user_return ON skipped_candidate_counterfactuals (user_id, return_pct);

    CREATE TABLE IF NOT EXISTS counterfactual_learning_watermarks (
      user_id TEXT PRIMARY KEY,
      last_audit_rowid INTEGER,
      last_audit_created_at TEXT,
      last_audit_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_data_demands (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      last_requested_at TEXT NOT NULL,
      fulfilled_at TEXT,
      expires_at TEXT NOT NULL,
      UNIQUE(kind, symbol, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_market_data_demands_pending ON market_data_demands (kind, symbol, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_market_data_demands_user ON market_data_demands (user_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS user_watchlist (
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (user_id, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_user_watchlist_user ON user_watchlist (user_id);

    CREATE TABLE IF NOT EXISTS price_alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      op TEXT NOT NULL CHECK(op IN ('<', '>')),
      price REAL NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('armed', 'triggered')),
      created_at TEXT NOT NULL,
      triggered_at TEXT,
      triggered_price REAL
    );
    CREATE INDEX IF NOT EXISTS idx_price_alerts_user_status ON price_alerts (user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id TEXT PRIMARY KEY,
      channels TEXT NOT NULL DEFAULT '[]',
      push_target TEXT NOT NULL DEFAULT '',
      webhook_url TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL,
      citations TEXT NOT NULL DEFAULT '[]',
      intent TEXT,
      redacted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_turns_user ON chat_turns (user_id, created_at);
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

  const counterfactualWatermarkColumns = database.prepare("PRAGMA table_info(counterfactual_learning_watermarks)").all() as Array<{ name: string }>;
  if (!counterfactualWatermarkColumns.some((column) => column.name === "last_audit_rowid")) {
    database.exec("ALTER TABLE counterfactual_learning_watermarks ADD COLUMN last_audit_rowid INTEGER");
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
  // R3: per-account tax treatment (taxable vs Roth/Traditional IRA) on existing DBs.
  const connectedAccountColumns = database.prepare("PRAGMA table_info(connected_accounts)").all() as Array<{ name: string }>;
  if (!connectedAccountColumns.some((column) => column.name === "taxation_type")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN taxation_type TEXT");
  }
  // Rename: legacy "dry_run" proposal status is now "paper".
  database.exec("UPDATE trade_proposals SET status = 'paper' WHERE status = 'dry_run'");

  const now = new Date().toISOString();
  const ensure = database.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)");
  ensure.run("policy", JSON.stringify(DEFAULT_POLICY), now);
  ensure.run("strategyPrompt", JSON.stringify(DEFAULT_STRATEGY_PROMPT), now);
  ensureDefaultProfile(database, now);
  applySp500DefaultUniverseMigration(database, now);
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

function applySp500DefaultUniverseMigration(database: Database.Database, now: string): void {
  const applied = database
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SP500_DEFAULT_UNIVERSE_MIGRATION_KEY);
  if (applied) return;

  const migratePolicyJson = (raw: string): TradingPolicy | undefined => {
    try {
      const policy = JSON.parse(raw) as Partial<TradingPolicy>;
      if (!isPristineEmptyUniversePolicy(policy)) return undefined;
      return mergePolicy({ ...policy, includedIndices: ["sp500"] });
    } catch {
      return undefined;
    }
  };

  const settingsPolicy = database.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string } | undefined;
  const migratedSettingsPolicy = settingsPolicy ? migratePolicyJson(settingsPolicy.value) : undefined;
  if (migratedSettingsPolicy) {
    database
      .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'policy'")
      .run(JSON.stringify(migratedSettingsPolicy), now);
  }

  const userSettingsPolicies = database
    .prepare("SELECT id, value FROM user_settings WHERE key = 'policy'")
    .all() as Array<{ id: string; value: string }>;
  const updateUserSetting = database.prepare("UPDATE user_settings SET value = ?, updated_at = ? WHERE id = ?");
  for (const row of userSettingsPolicies) {
    const migratedPolicy = migratePolicyJson(row.value);
    if (migratedPolicy) updateUserSetting.run(JSON.stringify(migratedPolicy), now, row.id);
  }

  const defaultProfiles = database
    .prepare("SELECT id, policy FROM strategy_profiles WHERE id = 'default'")
    .all() as Array<{ id: string; policy: string }>;
  const updateProfile = database.prepare("UPDATE strategy_profiles SET policy = ?, scoring_weights = ?, updated_at = ? WHERE id = ?");
  for (const row of defaultProfiles) {
    const migratedPolicy = migratePolicyJson(row.policy);
    if (migratedPolicy) {
      updateProfile.run(JSON.stringify(migratedPolicy), JSON.stringify(migratedPolicy.scoringWeights), now, row.id);
    }
  }

  database
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(SP500_DEFAULT_UNIVERSE_MIGRATION_KEY, JSON.stringify({ appliedAt: now }), now);
}

function isPristineEmptyUniversePolicy(policy: Partial<TradingPolicy>): boolean {
  const additionalSymbols = policy.additionalSymbols ?? [];
  const blocklist = policy.blocklist ?? [];
  return (
    Array.isArray(policy.includedIndices) &&
    policy.includedIndices.length === 0 &&
    Array.isArray(additionalSymbols) &&
    additionalSymbols.length === 0 &&
    Array.isArray(blocklist) &&
    blocklist.length === 0
  );
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

export type MarketDataDemandKind = "history";

export interface MarketDataDemandFill {
  kind: MarketDataDemandKind;
  symbol: string;
  pendingUserCount: number;
  oldestRequestedAt: string;
  latestRequestedAt: string;
  fulfilledAt: string;
}

function marketDataDemandTtlMs(): number {
  const parsed = Number(process.env.MARKET_DATA_PENDING_TTL_MS ?? 30 * 60_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60_000;
}

function normalizeDemandSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isoFromNow(now: number | string | Date): string {
  if (typeof now === "string") return now;
  return new Date(now).toISOString();
}

function pruneExpiredMarketDataDemands(nowIso: string): void {
  getDb()
    .prepare("UPDATE market_data_demands SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
    .run(nowIso);
}

export function recordMarketDataDemand(input: {
  kind: MarketDataDemandKind;
  symbol: string;
  userId?: string;
  now?: number | string | Date;
  ttlMs?: number;
}): void {
  const kind = input.kind;
  const symbol = normalizeDemandSymbol(input.symbol);
  if (!symbol) return;
  const userId = input.userId ?? "local";
  const nowIso = isoFromNow(input.now ?? new Date());
  const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs! > 0 ? input.ttlMs! : marketDataDemandTtlMs();
  const expiresAt = new Date(Date.parse(nowIso) + ttlMs).toISOString();
  const id = `${kind}:${symbol}:${userId}`;
  pruneExpiredMarketDataDemands(nowIso);
  getDb()
    .prepare(
      `INSERT INTO market_data_demands (
        id, kind, symbol, user_id, status, requested_at, last_requested_at, fulfilled_at, expires_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?)
      ON CONFLICT(kind, symbol, user_id) DO UPDATE SET
        status = 'pending',
        requested_at = CASE
          WHEN market_data_demands.status = 'pending' THEN market_data_demands.requested_at
          ELSE excluded.requested_at
        END,
        last_requested_at = excluded.last_requested_at,
        fulfilled_at = NULL,
        expires_at = excluded.expires_at`
    )
    .run(id, kind, symbol, userId, nowIso, nowIso, expiresAt);
}

export function fulfillMarketDataDemand(input: {
  kind: MarketDataDemandKind;
  symbol: string;
  now?: number | string | Date;
}): MarketDataDemandFill | undefined {
  const kind = input.kind;
  const symbol = normalizeDemandSymbol(input.symbol);
  if (!symbol) return undefined;
  const fulfilledAt = isoFromNow(input.now ?? new Date());
  pruneExpiredMarketDataDemands(fulfilledAt);
  const rows = getDb()
    .prepare(
      `SELECT user_id, requested_at, last_requested_at
       FROM market_data_demands
       WHERE kind = ? AND symbol = ? AND status = 'pending' AND expires_at > ?`
    )
    .all(kind, symbol, fulfilledAt) as Array<{ user_id: string; requested_at: string; last_requested_at: string }>;
  if (rows.length === 0) return undefined;

  getDb()
    .prepare(
      `UPDATE market_data_demands
       SET status = 'fulfilled', fulfilled_at = ?
       WHERE kind = ? AND symbol = ? AND status = 'pending' AND expires_at > ?`
    )
    .run(fulfilledAt, kind, symbol, fulfilledAt);

  return {
    kind,
    symbol,
    pendingUserCount: new Set(rows.map((row) => row.user_id)).size,
    oldestRequestedAt: rows.reduce((min, row) => (row.requested_at < min ? row.requested_at : min), rows[0].requested_at),
    latestRequestedAt: rows.reduce((max, row) => (row.last_requested_at > max ? row.last_requested_at : max), rows[0].last_requested_at),
    fulfilledAt
  };
}

export function clearMarketDataDemandsForTests(): void {
  getDb().prepare("DELETE FROM market_data_demands").run();
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
    policy.accountNumber = activeAccount.accountNumber;
    // The active account IS the mode: the Test account runs the local simulator
    // (paperMode), while any real broker account (Alpaca paper/brokerage, Robinhood)
    // runs against the broker. There is no separate paperMode override anymore.
    policy.paperMode = activeAccount.broker === "test";
  } else {
    policy.paperMode = true;
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

/**
 * Order notional executed within a rolling window of `minutes` (R1 hourly cap). Mirrors
 * dailyExecutionStats but on an arbitrary lookback rather than the calendar day.
 */
export function notionalInLastMinutes(accountNumber: string, minutes: number, now = new Date(), userId: string = "local"): { orderCount: number; notional: number } {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = getDb()
    .prepare(
      "SELECT proposal, estimated_notional FROM trade_proposals WHERE created_at >= ? AND account_number = ? AND user_id = ? AND status IN ('placed', 'paper')"
    )
    .all(cutoff.toISOString(), accountNumber, userId) as Array<{ proposal: string; estimated_notional: number | null }>;

  return rows.reduce(
    (acc, row) => {
      const proposal = JSON.parse(row.proposal) as { side?: string; dollarAmount?: number; quantity?: number; limitPrice?: number };
      const isBuy = proposal.side === "buy" || proposal.side === "short";
      const notional = isBuy
        ? (row.estimated_notional != null ? row.estimated_notional : (proposal.dollarAmount ?? (proposal.quantity ?? 0) * (proposal.limitPrice ?? 0)))
        : 0;
      return { orderCount: acc.orderCount + 1, notional: acc.notional + notional };
    },
    { orderCount: 0, notional: 0 }
  );
}

// ── Run lock ──────────────────────────────────────────────────────────────────
// Uses a direct prepared statement (not setSetting) to avoid noisy policy_change
// audit events.

export function acquireStrategyLock(userId: string = "local", staleMs = 5 * 60_000, now = new Date()): boolean {
  const database = getDb();
  const key = `strategy_run_lock:${userId}`;
  const acquire = database.transaction(() => {
    const row = database
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;

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
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(key, value, now.toISOString());
    return true;
  });

  return acquire() as boolean;
}

export function releaseStrategyLock(userId: string = "local"): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(`strategy_run_lock:${userId}`);
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
  if ((merged.maxDailyNotional ?? 0) >= 500_000) {
    merged.maxDailyNotional = DEFAULT_POLICY.maxDailyNotional;
    if (merged.maxDailyOrders > DEFAULT_POLICY.maxDailyOrders) merged.maxDailyOrders = DEFAULT_POLICY.maxDailyOrders;
  }
  if ((merged.maxOrderNotional ?? 0) > 100_000) merged.maxOrderNotional = 100_000;
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

export type ApiKeySource = "user" | "env" | "none";

const API_KEY_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  finnhub: "FINNHUB_API_KEY",
  fmp: "FMP_API_KEY",
  alphavantage: "ALPHAVANTAGE_API_KEY",
  marketstack: "MARKETSTACK_API_KEY",
  tradier: "TRADIER_API_KEY",
  fred: "FRED_API_KEY",
  sec_edgar_user_agent: "SEC_EDGAR_USER_AGENT",
  massive: "MASSIVE_API_KEY",
  massive_s3_endpoint: "MASSIVE_S3_ENDPOINT",
  massive_bucket: "MASSIVE_BUCKET",
  massive_access_key_id: "MASSIVE_ACCESS_KEY_ID",
  massive_secret_access_key: "MASSIVE_SECRET_ACCESS_KEY",
  pinecone: "PINECONE_API_KEY",
  voyage: "VOYAGE_API_KEY",
  alpaca_paper_api_key: "ALPACA_PAPER_API_KEY",
  alpaca_paper_secret_key: "ALPACA_PAPER_SECRET_KEY",
  apify: "APIFY_API_TOKEN"
};

const API_KEY_SERVICE_ALIASES: Record<string, string> = {
  alpha_vantage: "alphavantage",
  alphavantage_api_key: "alphavantage",
  finnhub_api_key: "finnhub",
  fmp_api_key: "fmp",
  openai_api_key: "openai",
  marketstack_api_key: "marketstack",
  tradier_api_key: "tradier",
  fred_api_key: "fred",
  sec_edgar: "sec_edgar_user_agent",
  sec_edgar_user_agent: "sec_edgar_user_agent",
  massive_api_key: "massive",
  pinecone_api_key: "pinecone",
  voyage_api_key: "voyage",
  alpaca_paper_api_key: "alpaca_paper_api_key",
  alpaca_paper_secret_key: "alpaca_paper_secret_key",
  apify_api_token: "apify"
};

function keyRowToApiKey(row: {
  id: string;
  user_id: string;
  service: string;
  api_key: string;
  label: string | null;
  created_at: string;
  updated_at: string;
}): UserApiKey {
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

export function normalizeApiKeyService(service: string): string {
  const normalized = service.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return API_KEY_SERVICE_ALIASES[normalized] ?? normalized;
}

export function apiKeyEnvVarForService(service: string): string | undefined {
  const canonical = normalizeApiKeyService(service);
  return API_KEY_ENV_MAP[canonical];
}

export function listSupportedApiKeyServices(): string[] {
  return Object.keys(API_KEY_ENV_MAP);
}

export function getUserApiKey(userId: string, service: string): UserApiKey | undefined {
  const canonical = normalizeApiKeyService(service);
  const statement = getDb().prepare("SELECT id, user_id, service, api_key, label, created_at, updated_at FROM user_api_keys WHERE user_id = ? AND service = ?");
  const row =
    (statement.get(userId, canonical) as { id: string; user_id: string; service: string; api_key: string; label: string | null; created_at: string; updated_at: string } | undefined) ??
    (canonical !== service
      ? (statement.get(userId, service) as { id: string; user_id: string; service: string; api_key: string; label: string | null; created_at: string; updated_at: string } | undefined)
      : undefined);
  if (!row) return undefined;
  return keyRowToApiKey(row);
}

export function listUserApiKeys(userId: string): UserApiKey[] {
  const rows = getDb()
    .prepare("SELECT id, user_id, service, api_key, label, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY service")
    .all(userId) as Array<{ id: string; user_id: string; service: string; api_key: string; label: string | null; created_at: string; updated_at: string }>;
  return rows.map(keyRowToApiKey);
}

export function upsertUserApiKey(userId: string, service: string, apiKey: string, label?: string): UserApiKey {
  const canonical = normalizeApiKeyService(service);
  const now = new Date().toISOString();
  const id = `${userId}_${canonical}`;
  const encryptedKey = encryptValue(apiKey);
  getDb()
    .prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET api_key = excluded.api_key, label = excluded.label, updated_at = excluded.updated_at`
    )
    .run(id, userId, canonical, encryptedKey, label ?? null, now, now);
  return { id, userId, service: canonical, apiKey, label, createdAt: now, updatedAt: now };
}

export function deleteUserApiKey(userId: string, service: string): void {
  const canonical = normalizeApiKeyService(service);
  const db = getDb();
  db.prepare("DELETE FROM user_api_keys WHERE user_id = ? AND service = ?").run(userId, canonical);
  if (canonical !== service) {
    db.prepare("DELETE FROM user_api_keys WHERE user_id = ? AND service = ?").run(userId, service);
  }
}

export function listConnectedAccounts(userId: string = "local"): ConnectedAccount[] {
  const rows = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as Record<string, unknown>[];
  return rows.map(r => ({
    id: String(r.id),
    userId: String(r.user_id),
    broker: String(r.broker) as "alpaca" | "robinhood" | "test",
    environment: String(r.environment) as "live" | "paper",
    accountNumber: r.account_number != null ? String(r.account_number) : undefined,
    label: String(r.label),
    taxationType: r.taxation_type != null ? (String(r.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    isActive: r.is_active === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  }));
}

// A "Test" account (local simulator: real quotes, simulated fills) is always available
// as the safe default. Selecting it = Test mode; selecting a real broker account = that
// broker's mode. This replaces the old paperMode toggle.
export function ensureTestAccount(userId: string = "local"): void {
  const accounts = listConnectedAccounts(userId);
  if (accounts.some((a) => a.broker === "test")) return;
  upsertConnectedAccount({
    id: `test-${userId}`,
    userId,
    broker: "test",
    environment: "paper",
    accountNumber: "TEST",
    label: "Test",
    isActive: accounts.every((a) => !a.isActive)
  });
}

export function getActiveConnectedAccount(userId: string = "local"): ConnectedAccount | undefined {
  const row = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? AND is_active = 1 LIMIT 1")
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    broker: String(row.broker) as "alpaca" | "robinhood" | "test",
    environment: String(row.environment) as "live" | "paper",
    accountNumber: row.account_number != null ? String(row.account_number) : undefined,
    label: String(row.label),
    taxationType: row.taxation_type != null ? (String(row.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    apiKey: row.api_key ? decryptValue(String(row.api_key)) : undefined,
    apiSecret: row.api_secret ? decryptValue(String(row.api_secret)) : undefined,
    isActive: row.is_active === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
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
        `INSERT INTO connected_accounts (id, user_id, broker, environment, account_number, label, api_key, api_secret, taxation_type, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          broker = excluded.broker,
          environment = excluded.environment,
          account_number = excluded.account_number,
          label = excluded.label,
          api_key = COALESCE(excluded.api_key, connected_accounts.api_key),
          api_secret = COALESCE(excluded.api_secret, connected_accounts.api_secret),
          taxation_type = COALESCE(excluded.taxation_type, connected_accounts.taxation_type),
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
        account.taxationType ?? null,
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

// ── Synthetic trailing stops (R2 scaffolding) ──────────────────────────────────
export interface SyntheticTrailingStop {
  id: string;
  userId: string;
  accountNumber: string;
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  /** Highest price since entry for a long (lowest for a short) — the trail anchor. */
  extremePrice: number;
  trailPercent?: number;
  trailAmount?: number;
  status: "active" | "triggered" | "cancelled";
  lastPrice?: number;
  createdAt: string;
  updatedAt: string;
}

function mapSyntheticStop(r: Record<string, unknown>): SyntheticTrailingStop {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    accountNumber: String(r.account_number),
    symbol: String(r.symbol),
    side: String(r.side) as "long" | "short",
    quantity: Number(r.quantity),
    entryPrice: Number(r.entry_price),
    extremePrice: Number(r.extreme_price),
    trailPercent: r.trail_percent != null ? Number(r.trail_percent) : undefined,
    trailAmount: r.trail_amount != null ? Number(r.trail_amount) : undefined,
    status: String(r.status) as SyntheticTrailingStop["status"],
    lastPrice: r.last_price != null ? Number(r.last_price) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  };
}

export function upsertSyntheticStop(stop: Omit<SyntheticTrailingStop, "createdAt" | "updatedAt"> & { createdAt?: string }): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO synthetic_trailing_stops (id, user_id, account_number, symbol, side, quantity, entry_price, extreme_price, trail_percent, trail_amount, status, last_price, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol) DO UPDATE SET
        side = excluded.side,
        quantity = excluded.quantity,
        entry_price = excluded.entry_price,
        extreme_price = excluded.extreme_price,
        trail_percent = excluded.trail_percent,
        trail_amount = excluded.trail_amount,
        status = excluded.status,
        last_price = excluded.last_price,
        updated_at = excluded.updated_at`
    )
    .run(
      stop.id, stop.userId, stop.accountNumber, stop.symbol, stop.side, stop.quantity,
      stop.entryPrice, stop.extremePrice, stop.trailPercent ?? null, stop.trailAmount ?? null,
      stop.status, stop.lastPrice ?? null, stop.createdAt ?? now, now
    );
}

export function listSyntheticStops(accountNumber: string, userId: string = "local", status: SyntheticTrailingStop["status"] = "active"): SyntheticTrailingStop[] {
  const rows = getDb()
    .prepare("SELECT * FROM synthetic_trailing_stops WHERE user_id = ? AND account_number = ? AND status = ? ORDER BY created_at ASC")
    .all(userId, accountNumber, status) as Record<string, unknown>[];
  return rows.map(mapSyntheticStop);
}

export function deleteSyntheticStop(id: string, userId: string = "local"): void {
  getDb().prepare("DELETE FROM synthetic_trailing_stops WHERE id = ? AND user_id = ?").run(id, userId);
}

/** Purge stops whose position no longer exists (size hit 0). `liveSymbols` must be upper-cased. */
export function purgeSyntheticStops(accountNumber: string, liveSymbols: Set<string>, userId: string = "local"): number {
  let purged = 0;
  for (const stop of listSyntheticStops(accountNumber, userId)) {
    if (!liveSymbols.has(stop.symbol.toUpperCase())) {
      deleteSyntheticStop(stop.id, userId);
      purged++;
    }
  }
  return purged;
}

export function resolveApiKeyWithSource(service: string, userId?: string): { key?: string; source: ApiKeySource; envVar?: string; service: string } {
  const canonical = normalizeApiKeyService(service);
  if (userId) {
    const userKey = getUserApiKey(userId, canonical);
    if (userKey?.apiKey) return { key: userKey.apiKey, source: "user", service: canonical };
  }
  const envVar = apiKeyEnvVarForService(canonical);
  const envKey = envVar ? process.env[envVar] : undefined;
  if (envKey) return { key: envKey, source: "env", envVar, service: canonical };
  return { source: "none", envVar, service: canonical };
}

/**
 * Resolves the API key for a given service, checking per-user storage first,
 * then falling back to the environment variable.
 */
export function resolveApiKey(service: string, userId?: string): string | undefined {
  return resolveApiKeyWithSource(service, userId).key;
}

export function listUsers(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT user_id FROM user_settings
       UNION
       SELECT user_id FROM strategy_profiles
       UNION
       SELECT user_id FROM user_api_keys
       UNION
       SELECT user_id FROM connected_accounts
       UNION
       SELECT user_id FROM user_watchlist
       UNION
       SELECT user_id FROM price_alerts`
    )
    .all() as Array<{ user_id: string }>;
  const users = rows.map((r) => r.user_id).filter(Boolean);
  return users.length > 0 ? Array.from(new Set(users)) : ["local"];
}

type RawWatchlistRow = { symbol: string; added_at: string };
type RawPriceAlertRow = {
  id: string;
  user_id: string;
  symbol: string;
  op: string;
  price: number;
  note: string;
  status: string;
  created_at: string;
  triggered_at: string | null;
  triggered_price: number | null;
};

function mapPriceAlert(row: RawPriceAlertRow): PriceAlert {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    op: row.op as PriceAlertOp,
    price: row.price,
    note: row.note,
    status: row.status as PriceAlertStatus,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
    triggeredPrice: row.triggered_price
  };
}

export function addWatchlistSymbol(userId: string, symbol: string): WatchlistItem {
  const addedAt = new Date().toISOString();
  getDb()
    .prepare("INSERT OR IGNORE INTO user_watchlist (user_id, symbol, added_at) VALUES (?, ?, ?)")
    .run(userId, symbol, addedAt);
  const row = getDb()
    .prepare("SELECT symbol, added_at FROM user_watchlist WHERE user_id = ? AND symbol = ?")
    .get(userId, symbol) as RawWatchlistRow;
  return { symbol: row.symbol, addedAt: row.added_at };
}

export function removeWatchlistSymbol(userId: string, symbol: string): boolean {
  const result = getDb().prepare("DELETE FROM user_watchlist WHERE user_id = ? AND symbol = ?").run(userId, symbol);
  return result.changes > 0;
}

export function listWatchlistSymbols(userId: string): WatchlistItem[] {
  const rows = getDb()
    .prepare("SELECT symbol, added_at FROM user_watchlist WHERE user_id = ? ORDER BY symbol ASC")
    .all(userId) as RawWatchlistRow[];
  return rows.map((row) => ({ symbol: row.symbol, addedAt: row.added_at }));
}

export function createPriceAlert(alert: PriceAlert): PriceAlert {
  getDb()
    .prepare(
      `INSERT INTO price_alerts
       (id, user_id, symbol, op, price, note, status, created_at, triggered_at, triggered_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      alert.id,
      alert.userId,
      alert.symbol,
      alert.op,
      alert.price,
      alert.note,
      alert.status,
      alert.createdAt,
      alert.triggeredAt,
      alert.triggeredPrice
    );
  return alert;
}

export function listPriceAlerts(userId: string, status: "all" | "armed" | "triggered" = "all"): PriceAlert[] {
  const rows =
    status === "all"
      ? (getDb()
          .prepare("SELECT * FROM price_alerts WHERE user_id = ? ORDER BY created_at DESC")
          .all(userId) as RawPriceAlertRow[])
      : (getDb()
          .prepare("SELECT * FROM price_alerts WHERE user_id = ? AND status = ? ORDER BY created_at DESC")
          .all(userId, status) as RawPriceAlertRow[]);
  return rows.map(mapPriceAlert);
}

export function listArmedPriceAlerts(userId: string): PriceAlert[] {
  return listPriceAlerts(userId, "armed");
}

export function deletePriceAlert(userId: string, id: string): boolean {
  const result = getDb().prepare("DELETE FROM price_alerts WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export function markPriceAlertTriggered(id: string, userId: string, triggeredPrice: number): PriceAlert | null {
  const triggeredAt = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE price_alerts
       SET status = 'triggered', triggered_at = ?, triggered_price = ?
       WHERE id = ? AND user_id = ? AND status = 'armed'`
    )
    .run(triggeredAt, triggeredPrice, id, userId);
  if (result.changes === 0) return null;
  const row = getDb().prepare("SELECT * FROM price_alerts WHERE id = ? AND user_id = ?").get(id, userId) as RawPriceAlertRow | undefined;
  return row ? mapPriceAlert(row) : null;
}

const NOTIFY_CHANNEL_IDS: readonly NotifyChannelId[] = ["push", "webhook", "email", "sms"];

function isNotifyChannelId(value: unknown): value is NotifyChannelId {
  return typeof value === "string" && (NOTIFY_CHANNEL_IDS as readonly string[]).includes(value);
}

export function getNotifyPrefs(userId: string = "local"): NotifyPrefs {
  const row = getDb().prepare("SELECT * FROM notification_prefs WHERE user_id = ?").get(userId) as
    | { user_id: string; channels: string; push_target: string; webhook_url: string; email: string; phone: string; updated_at: string | null }
    | undefined;
  if (!row) {
    return { userId, channels: [], pushTarget: "", webhookUrl: "", email: "", phone: "", updatedAt: null };
  }
  let channels: NotifyChannelId[] = [];
  try {
    const parsed = JSON.parse(row.channels) as unknown;
    if (Array.isArray(parsed)) channels = parsed.filter(isNotifyChannelId);
  } catch {
    channels = [];
  }
  return {
    userId: row.user_id,
    channels,
    pushTarget: row.push_target,
    webhookUrl: row.webhook_url,
    email: row.email,
    phone: row.phone,
    updatedAt: row.updated_at
  };
}

export function setNotifyPrefs(
  userId: string,
  partial: { channels?: unknown; pushTarget?: unknown; webhookUrl?: unknown; email?: unknown; phone?: unknown }
): NotifyPrefs {
  const next: NotifyPrefs = { ...getNotifyPrefs(userId), userId };
  if (Array.isArray(partial.channels)) {
    next.channels = [...new Set(partial.channels.filter(isNotifyChannelId))];
  }
  if (typeof partial.pushTarget === "string") next.pushTarget = partial.pushTarget.trim();
  if (typeof partial.webhookUrl === "string") next.webhookUrl = partial.webhookUrl.trim();
  if (typeof partial.email === "string") next.email = partial.email.trim();
  if (typeof partial.phone === "string") next.phone = partial.phone.trim();
  next.updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO notification_prefs (user_id, channels, push_target, webhook_url, email, phone, updated_at)
       VALUES (@userId, @channels, @pushTarget, @webhookUrl, @email, @phone, @updatedAt)
       ON CONFLICT(user_id) DO UPDATE SET
         channels = excluded.channels, push_target = excluded.push_target, webhook_url = excluded.webhook_url,
         email = excluded.email, phone = excluded.phone, updated_at = excluded.updated_at`
    )
    .run({
      userId,
      channels: JSON.stringify(next.channels),
      pushTarget: next.pushTarget,
      webhookUrl: next.webhookUrl,
      email: next.email,
      phone: next.phone,
      updatedAt: next.updatedAt
    });
  audit("notify.prefs.set", { userId, channels: next.channels }, userId);
  return next;
}

interface RawChatTurnRow {
  id: string;
  user_id: string;
  role: string;
  text: string;
  citations: string;
  intent: string | null;
  redacted: number;
  created_at: string;
}

function mapChatTurn(row: RawChatTurnRow): ChatTurn {
  let citations: string[] = [];
  try {
    const parsed = JSON.parse(row.citations) as unknown;
    if (Array.isArray(parsed)) citations = parsed.filter((c): c is string => typeof c === "string");
  } catch {
    citations = [];
  }
  const role: ChatTurnRole = row.role === "assistant" ? "assistant" : "user";
  return {
    id: row.id,
    userId: row.user_id,
    role,
    text: row.text,
    citations,
    intent: row.intent,
    redacted: row.redacted === 1,
    createdAt: row.created_at
  };
}

export function insertChatTurn(turn: ChatTurn): ChatTurn {
  getDb()
    .prepare(
      "INSERT INTO chat_turns (id, user_id, role, text, citations, intent, redacted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(turn.id, turn.userId, turn.role, turn.text, JSON.stringify(turn.citations), turn.intent ?? null, turn.redacted ? 1 : 0, turn.createdAt);
  return turn;
}

export function listChatTurns(userId: string, limit: number = 100): ChatTurn[] {
  const rows = getDb()
    .prepare("SELECT * FROM chat_turns WHERE user_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(userId) as RawChatTurnRow[];
  const mapped = rows.map(mapChatTurn);
  return limit > 0 && mapped.length > limit ? mapped.slice(mapped.length - limit) : mapped;
}

/** Keep only the most recent `keep` turns for a user (FIFO cap); returns rows deleted. */
export function trimChatTurns(userId: string, keep: number): number {
  return getDb()
    .prepare(
      `DELETE FROM chat_turns WHERE user_id = ? AND id NOT IN (
         SELECT id FROM chat_turns WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`
    )
    .run(userId, userId, keep).changes;
}

export function clearChatTurns(userId: string): number {
  return getDb().prepare("DELETE FROM chat_turns WHERE user_id = ?").run(userId).changes;
}
