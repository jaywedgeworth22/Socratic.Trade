// db.ts — core: DB initialisation, schema/migrations, getDb(), audit().
// Every function that was previously here has been extracted into focused modules;
// this file re-exports them all so every existing `import ... from "./db"` (or
// `"../lib/db"`, `"@/lib/db"`, etc.) continues to resolve without any changes.

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import crypto from "crypto";
import { DEFAULT_POLICY, DEFAULT_SCORING_WEIGHTS, DEFAULT_STRATEGY_PROMPT } from "./defaults";
import type { TradingPolicy } from "./types";

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
  // With WAL, a concurrent writer otherwise throws SQLITE_BUSY immediately; wait
  // up to 5s for the lock instead. NORMAL durability is the WAL-recommended pairing.
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

export function audit(kind: string, payload: unknown, userId: string = "local"): void {
  getDb()
    .prepare("INSERT INTO audit_events (id, user_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), userId, new Date().toISOString(), kind, JSON.stringify(payload));
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
      base_url TEXT,
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

    CREATE TABLE IF NOT EXISTS user_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user_stated',
      confidence REAL NOT NULL DEFAULT 0.5,
      hard INTEGER NOT NULL DEFAULT 0,
      asserted_at TEXT NOT NULL,
      superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory (user_id, superseded_by);

    CREATE TABLE IF NOT EXISTS ingested_accessions (
      accession TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      ticker TEXT NOT NULL DEFAULT '',
      indexed_at TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (accession, doc_type)
    );
    CREATE TABLE IF NOT EXISTS learned_context (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('private','shared')),
      kind TEXT NOT NULL CHECK(kind IN ('pattern','decision','fact')),
      subject TEXT NOT NULL,
      symbol TEXT,
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'inferred',
      origin TEXT NOT NULL CHECK(origin IN ('chat','autonomous','ingest')),
      risk_tier TEXT NOT NULL DEFAULT 'fact' CHECK(risk_tier IN ('fact','risk','strategy-directive')),
      confidence REAL NOT NULL DEFAULT 0.5,
      contributor_user_id TEXT,
      asserted_at TEXT NOT NULL,
      superseded_by TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_learned_context_user ON learned_context (user_id, scope, superseded_by);
    CREATE INDEX IF NOT EXISTS idx_learned_context_symbol ON learned_context (symbol, scope, superseded_by);
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
  // Proposal staleness: when a run's LLM re-validation re-checks a still-pending proposal,
  // stamp when and why it still stands so the queue can show "re-checked X ago" rather than
  // implying an old idea is still freshly recommended.
  if (!columns.some((column) => column.name === "last_revalidated_at")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN last_revalidated_at TEXT");
    database.exec("ALTER TABLE trade_proposals ADD COLUMN revalidation_note TEXT");
  }
  // MAE/MFE persistence: add excursion columns to fill_events (additive, guarded).
  const fillEventColumns = database.prepare("PRAGMA table_info(fill_events)").all() as Array<{ name: string }>;
  if (!fillEventColumns.some((c) => c.name === "mae")) {
    database.exec("ALTER TABLE fill_events ADD COLUMN mae REAL");
  }
  if (!fillEventColumns.some((c) => c.name === "mfe")) {
    database.exec("ALTER TABLE fill_events ADD COLUMN mfe REAL");
  }

  // R3: per-account tax treatment (taxable vs Roth/Traditional IRA) on existing DBs.
  const connectedAccountColumns = database.prepare("PRAGMA table_info(connected_accounts)").all() as Array<{ name: string }>;
  if (!connectedAccountColumns.some((column) => column.name === "taxation_type")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN taxation_type TEXT");
  }
  if (!connectedAccountColumns.some((column) => column.name === "base_url")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN base_url TEXT");
  }
  if (!connectedAccountColumns.some((column) => column.name === "capabilities")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN capabilities TEXT");
  }

  // Rename: legacy "dry_run" proposal status is now "paper".
  database.exec("UPDATE trade_proposals SET status = 'paper' WHERE status = 'dry_run'");

  const now = new Date().toISOString();
  // NOTE: We no longer seed global settings rows for 'policy' and 'strategyPrompt'.
  // These global rows are never read at runtime (all reads go through user_settings and
  // strategy_profiles by userId). The legacy seeds were removed in M3 (2026-06-21).
  migrateGlobalPolicyToLocalUser(database, now);
  ensureDefaultProfile(database, now);
  applySp500DefaultUniverseMigration(database, now);
}

/**
 * ONE-TIME migration (M3, 2026-06-21): copy any existing global-only 'policy' / 'strategyPrompt'
 * rows from the `settings` table into `user_settings` for the 'local' user, so that single-user
 * DBs that were seeded before the per-user migration lose nothing.
 *
 * Guard key prevents the copy from running more than once. After this runs, the global rows
 * become dead weight (never read at runtime) but are not deleted — they are harmless and their
 * presence cannot cause confusion because no runtime code reads them.
 */
const GLOBAL_POLICY_TO_LOCAL_MIGRATION_KEY = "migration:global_policy_to_local_user:2026-06-21";

export function migrateGlobalPolicyToLocalUser(database: Database.Database, now: string): void {
  const applied = database.prepare("SELECT value FROM settings WHERE key = ?").get(GLOBAL_POLICY_TO_LOCAL_MIGRATION_KEY);
  if (applied) return;

  const userId = "local";
  const policyRow = database.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string } | undefined;
  const promptRow = database.prepare("SELECT value FROM settings WHERE key = 'strategyPrompt'").get() as { value: string } | undefined;

  // Only copy if the user doesn't already have their own user_settings row.
  if (policyRow) {
    const existing = database.prepare("SELECT id FROM user_settings WHERE user_id = ? AND key = 'policy'").get(userId);
    if (!existing) {
      database
        .prepare("INSERT OR IGNORE INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(`${userId}_policy`, userId, "policy", policyRow.value, now);
    }
  }
  if (promptRow) {
    const existing = database.prepare("SELECT id FROM user_settings WHERE user_id = ? AND key = 'strategyPrompt'").get(userId);
    if (!existing) {
      database
        .prepare("INSERT OR IGNORE INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(`${userId}_strategyPrompt`, userId, "strategyPrompt", promptRow.value, now);
    }
  }

  database
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(GLOBAL_POLICY_TO_LOCAL_MIGRATION_KEY, JSON.stringify({ appliedAt: now }), now);
}

function ensureDefaultProfile(database: Database.Database, now: string): void {
  const userId = "local";
  const existing = database.prepare("SELECT COUNT(*) AS count FROM strategy_profiles WHERE user_id = ?").get(userId) as { count: number };
  if (existing.count === 0) {
    // Seed from user_settings (which migrateGlobalPolicyToLocalUser may have just populated)
    // or fall back to the compiled-in defaults. We no longer read from the global settings table.
    const userPolicyRow = database.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'").get(userId) as { value: string } | undefined;
    const userPromptRow = database.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'strategyPrompt'").get(userId) as { value: string } | undefined;
    const rawPolicy = userPolicyRow?.value ?? JSON.stringify(DEFAULT_POLICY);
    const policy = mergePolicy(JSON.parse(rawPolicy) as Partial<TradingPolicy>);
    const prompt = userPromptRow ? (JSON.parse(userPromptRow.value) as string) : DEFAULT_STRATEGY_PROMPT;
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

export function applySp500DefaultUniverseMigration(database: Database.Database, now: string): void {
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

  // NOTE: The global settings.policy row is no longer updated here (M3, 2026-06-21).
  // It is a dead row after the migrateGlobalPolicyToLocalUser migration; the canonical
  // policy for each user lives in user_settings and strategy_profiles.

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

// mergePolicy is needed by ensureDefaultProfile and applySp500DefaultUniverseMigration above,
// which run during migration (before modules are fully loaded). We keep a local copy here
// rather than importing from db-profiles to avoid a module-load-order issue at migrate() time.
// db-profiles.ts exports its own copy for runtime callers.
function mergePolicy(policy: Partial<TradingPolicy>): TradingPolicy {
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

function normalizeScoringWeights(weights: Partial<import("./types").ScoringWeights>): import("./types").ScoringWeights {
  return {
    ...DEFAULT_SCORING_WEIGHTS,
    ...Object.fromEntries(
      Object.entries(weights).map(([key, value]) => [key, Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0])
    )
  };
}

// ── Re-exports (barrel) ───────────────────────────────────────────────────────
// Every consumer of `import { X } from "./db"` continues to work unchanged.

export * from "./db-settings";
export * from "./db-learning";
export * from "./db-profiles";
export * from "./db-execution";
export * from "./db-proposals";
export * from "./db-fills";
export * from "./db-notifications";
export * from "./db-api-keys";
