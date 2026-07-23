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

export function accountSubjectToken(userId: string): string {
  // User IDs are already opaque (or the literal local operator id). This non-PII lookup token must
  // survive ENCRYPTION_KEY/audit-salt rotation; a rotatable secret would orphan completed fences.
  return crypto.createHash("sha256").update(`account-subject:v1|${String(userId)}`, "utf8").digest("hex");
}

function accountSettingMatchesSubject(key: unknown, subjectToken: unknown): number {
  if (typeof key !== "string" || typeof subjectToken !== "string") return 0;
  if (key.startsWith("account_user_operation:")) {
    return key.slice("account_user_operation:".length).startsWith(`${subjectToken}:`) ? 1 : 0;
  }
  // Canonical ownership registry for rows in the otherwise-global `settings` table. Keep the user
  // segment immediately after one of these prefixes; optional account/provider/hash suffixes are
  // allowed. The same matcher powers both the deletion sweep and the prepared/completed write
  // fence, so adding a new user-owned internal setting cannot be fixed in one path but missed in
  // the other.
  for (const prefix of [
    "strategy_run_lock:",
    "robinhood_mcp_oauth_token:",
    "robinhood_mcp_oauth_state:",
    "llm_budget_reservation:",
    "providerTier:status:",
    "providerTier:lastCheckAt:",
    "risk:hwm:",
    "risk:sod:",
    "learning_review:lastRunDate:",
    "learning_review:lastFingerprint:",
    "learning_review:lastReviewedAt:",
    "learning_review:lastConfig:",
    "learning_review:legacySeedDone:",
    "last_auto_tune_at:",
    "regime:current:",
    "congress_score_verdict:",
    "reflection_signature:",
    "model_rotation:",
    "stale_limit_order_alert:",
    "subMinimumOrderAlertSent:",
    "usageLimitAlert:lastSent:",
    "recoverable_issue:",
    "last_macro_sent:"
  ]) {
    if (!key.startsWith(prefix)) continue;
    let candidate = key.slice(prefix.length);
    while (candidate) {
      if (accountSubjectToken(candidate) === subjectToken) return 1;
      const separator = candidate.lastIndexOf(":");
      if (separator < 0) break;
      candidate = candidate.slice(0, separator);
    }
  }
  // A few provider-health keys predate the user-first convention. They are still account-owned;
  // recognize the final segment without treating global env/operator lanes as user data.
  if (key.startsWith("healthAlertSent:") && key.includes(":user:")) {
    return accountSubjectToken(key.slice(key.lastIndexOf(":user:") + ":user:".length)) === subjectToken ? 1 : 0;
  }
  if (key.startsWith("vectorStore:connectionAlert:")) {
    const candidate = key.slice(key.lastIndexOf(":") + 1);
    return accountSubjectToken(candidate) === subjectToken ? 1 : 0;
  }
  return 0;
}

export function databasePath(): string {
  const value = process.env.DATABASE_URL ?? "file:./data/app.db";
  return resolve(value.replace(/^file:/, ""));
}

export function getDb(): Database.Database {
  if (db) return db;
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.function("account_subject_token", { deterministic: true }, (value: unknown) => accountSubjectToken(String(value ?? "")));
  db.function("account_setting_matches_subject", { deterministic: true }, accountSettingMatchesSubject);
  db.pragma("journal_mode = WAL");
  // With WAL, a concurrent writer otherwise throws SQLITE_BUSY immediately; wait
  // up to 60s for the lock instead. NORMAL durability is the WAL-recommended pairing.
  // Raised from 30s (2026-07-18, PR #1728) after "database is locked" kept surfacing
  // in prod under heavy concurrent write load (bulk RAG backfill/reindex + scheduler
  // + burst ingest all writing the same file); WAL already lets readers proceed
  // during a writer, so a longer wait here only affects genuinely-contended writers,
  // not the common read path.
  db.pragma("busy_timeout = 60000");
  db.pragma("synchronous = NORMAL");
  // Larger page cache + memory-mapped I/O: the dashboard replays fill/proposal history on every
  // request, so a ~20MB page cache (negative = KB) and 256MB mmap keep those hot reads off the
  // syscall path with a fixed, modest memory ceiling.
  db.pragma("cache_size = -20000");
  db.pragma("mmap_size = 268435456");
  // Enforce declared foreign keys (SQLite leaves this off by default). Inert today (no FKs are
  // declared) but the correct default so any future FK constraint actually enforces.
  db.pragma("foreign_keys = ON");
  migrate(db);
  applyVersionedMigrations(db);
  installAccountWriteFenceTriggers(db);
  assertEncryptionKeyAvailable(db);
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

    CREATE TABLE IF NOT EXISTS account_write_fences (
      subject_token TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','completed')),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_write_fences_status
      ON account_write_fences (status, updated_at);

    CREATE TABLE IF NOT EXISTS account_identity_generations (
      base_subject_token TEXT PRIMARY KEY,
      current_user_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 0),
      status TEXT NOT NULL CHECK(status IN ('active','deleted')),
      session_cutoff_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_identity_current_user
      ON account_identity_generations (current_user_id);

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
      summary TEXT,
      account_number TEXT,
      policy_revision TEXT
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
      entry_market_regime TEXT,
      execution_mode TEXT,
      error_message TEXT,
      prompt_version TEXT
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

    -- Per-account LIVE strategy state (policy + system_state), keyed by the stable
    -- connected_accounts.id. strategy_profiles is the user-level copyable LIBRARY;
    -- this is what an account is actually running. Seeded lazily on first read
    -- (migration-on-read in db-profiles.getPolicy) so existing single-account users
    -- are byte-identical day one. No hard FK — deletion is handled in code
    -- (deleteConnectedAccount / account-deletion purge), matching the per-account
    -- execution tables above.
    CREATE TABLE IF NOT EXISTS account_strategy_state (
      user_id TEXT NOT NULL,
      connected_account_id TEXT NOT NULL,
      policy TEXT NOT NULL,
      prompt TEXT,
      scoring_weights TEXT,
      system_state TEXT NOT NULL DEFAULT 'halted',
      derived_from_profile_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, connected_account_id)
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
      created_at TEXT NOT NULL,
      execution_mode TEXT
    );

    CREATE TABLE IF NOT EXISTS order_replacements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      original_order_id TEXT NOT NULL,
      symbol TEXT,
      side TEXT,
      original_type TEXT,
      original_quantity REAL,
      original_filled_quantity REAL,
      replacement_ref_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('cancel_requested', 'cancel_confirmed', 'replacement_claiming', 'replacement_submitted', 'replacement_confirmed', 'failed', 'aborted')),
      remaining_quantity REAL,
      cancel_result TEXT,
      replacement_order_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
      filled_at TEXT NOT NULL,
      execution_mode TEXT
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

    -- Atomic dedupe reservations for option alerts. Dashboard snapshots invoke the option-alert
    -- check CONCURRENTLY, and each used to read the "already sent" set BEFORE any event row was
    -- inserted, so two concurrent requests could both deliver the same (account, symbol, alertType)
    -- alert. The UNIQUE constraint makes claiming the alert atomic: the first INSERT OR IGNORE wins
    -- (changes=1 => this caller delivers); a concurrent one no-ops (changes=0 => skip). Rows are
    -- released (deleted) when the send did NOT actually deliver, so a disabled/failed alert can
    -- still be delivered on a later cycle (matches the historical status='sent'-only dedupe).
    CREATE TABLE IF NOT EXISTS option_alert_reservations (
      user_id TEXT NOT NULL,
      connected_account_id TEXT NOT NULL DEFAULT '',
      symbol TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, connected_account_id, symbol, alert_type)
    );

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
      suspect_price REAL,
      suspect_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, account_number, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_synthetic_stops_account ON synthetic_trailing_stops (user_id, account_number);

    -- Broker-held protective stops: the resting protective order id placed at the broker for an open
    -- position, so it can be cancelled when the position closes (no orphaned stops). One per (user,
    -- account, symbol). Distinct from synthetic_trailing_stops, which is the app-side monitor.
    -- kind 'fixed' = stop-market at stopLossPct below entry (Robinhood, opt-in);
    -- kind 'trailing' = native Alpaca trailing_stop (trail_percent) or a Robinhood stop-market the
    -- reconciler ratchets upward each tick (trail_percent records the configured trail distance).
    CREATE TABLE IF NOT EXISTS broker_protective_stops (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      broker_order_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      stop_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'resting',
      kind TEXT NOT NULL DEFAULT 'fixed',
      trail_percent REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, account_number, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_broker_protective_stops_account ON broker_protective_stops (user_id, account_number);

    -- Take-profit trim ratchet: the highest take-profit "band" (floor(returnPct / takeProfitPct)) at
    -- which a partial trim has already been emitted for an open position. Monotonic per (user, account,
    -- symbol) so a partial take-profit trims once per band instead of laddering out every run; cleared
    -- when the position closes. One row per open profitable position.
    CREATE TABLE IF NOT EXISTS take_profit_trims (
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      band INTEGER NOT NULL,
      -- Position cost basis at the time the band was recorded. The ratchet is keyed to this lot: if the
      -- current position's average cost no longer matches, it's a new lot (close+rebuy) and the band resets.
      avg_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, account_number, symbol)
    );

    -- Per-position stop plan: the LLM's chosen stop-loss TYPE (StopPlanStyle) for an open position,
    -- set at opening-fill time and read by every stop-enforcement layer for the position's life.
    -- Monotonic per (user, account, symbol) like take_profit_trims above; keyed to the lot's cost
    -- basis so a close+rebuy starts fresh instead of inheriting a stale plan. Cleared when the
    -- position closes. One row per open position that has an explicit (non-"default") plan.
    CREATE TABLE IF NOT EXISTS position_stop_plans (
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      style TEXT NOT NULL,
      rationale TEXT,
      avg_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'long',
      opening_order_id TEXT,
      PRIMARY KEY (user_id, account_number, symbol)
    );

    -- A "fixed"/"atr" stop plan on Alpaca/Tradier is enforced via a broker-NATIVE bracket order
    -- (order_class bracket/otoco) attached at opening-fill time; position_stop_plans.opening_order_id
    -- tracks that order's ID. When the plan later changes away from fixed/atr (reset to trailing/
    -- none/default, or the row is cleared on close), the bracket's still-resting take-profit/stop-
    -- loss legs from that EARLIER opening are not automatically torn down — enrichOpeningProposal
    -- only strips bracket fields from the NEW order being placed, and has no reach into an already-
    -- resting broker order (this was the long-deferred "OCO sibling-identity pairing" gap, PR #1331/
    -- #1371). recordStopPlan/clearStopPlans enqueue a row here (best-effort) whenever they detect
    -- this transition; reconcilePendingBracketTeardowns (broker-protective-stops.ts) sweeps it,
    -- asking the broker gateway to identify and cancel the sibling legs by the tracked order ID.
    CREATE TABLE IF NOT EXISTS pending_bracket_teardowns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      order_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending_bracket_teardowns_account
      ON pending_bracket_teardowns(user_id, account_number);

    -- Every broker-native bracket order EVER placed for a (user, account, symbol) while its plan
    -- sits at "fixed"/"atr", appended on each fill — NOT just the latest. A single opening_order_id
    -- scalar column can't represent this: a same-style scale-in places a BRAND-NEW, independently
    -- resting bracket sized ONLY to its own added shares (Alpaca: orderArgs.qty from the order's own
    -- quantity; Tradier: each exit leg sized to that order's wholeQty) — it does NOT replace or
    -- resize the PRIOR bracket, which is still the genuine, still-needed protection for the
    -- pre-existing lot. Tearing down the prior bracket on a mere same-style scale-in (as an earlier,
    -- incomplete fix briefly did) would cancel a live, correct stop-loss/take-profit and leave that
    -- earlier lot with NO protection at all (Codex review, PR #1667). So rows here accumulate across
    -- same-style scale-ins and are ONLY ALL torn down together, via pending_bracket_teardowns, when
    -- the plan genuinely leaves the fixed/atr family (a real style change, or the position closes) —
    -- see enqueueTeardownForAllOpenBrackets in db-api-keys.ts.
    CREATE TABLE IF NOT EXISTS position_stop_plan_open_brackets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      order_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_position_stop_plan_open_brackets_symbol
      ON position_stop_plan_open_brackets(user_id, account_number, symbol);

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
      -- Multi-horizon outcome rows (JSON SocraticOutcomeHorizonRow[]) written at maturation, and the
      -- terminal-unresolvable reason (kill-survivorship: a delisted/renamed symbol becomes status
      -- 'unresolvable' with a reason after a bounded recheck window instead of pending forever).
      outcomes TEXT,
      resolution_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, run_id, symbol, horizon_days)
    );
    CREATE INDEX IF NOT EXISTS idx_skipped_counterfactuals_user_status_target ON skipped_candidate_counterfactuals (user_id, status, target_date);
    CREATE INDEX IF NOT EXISTS idx_skipped_counterfactuals_user_return ON skipped_candidate_counterfactuals (user_id, return_pct);

    CREATE TABLE IF NOT EXISTS counterfactual_learning_watermarks (
      user_id TEXT NOT NULL,
      connected_account_id TEXT NOT NULL DEFAULT '',
      last_audit_rowid INTEGER,
      last_audit_created_at TEXT,
      last_audit_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, connected_account_id)
    );

    -- Unified append-only ledger of EVERY autonomous learning mutation (panel P0-4). One canonical row per
    -- gated mutation (factor-weight applies today; any future auto-tuning), carrying before/after snapshots,
    -- the subsystem, the trigger/run id, the OOS/statistical evidence, and the flag in effect. Recording is
    -- passive/always-on (it only writes an audit trail; it changes no trading behavior). The admin revert
    -- route reads a row and restores before_state via setPolicy. Scoped by (user_id, connected_account_id,
    -- subsystem) so a revert cannot cross accounts or subsystems.
    CREATE TABLE IF NOT EXISTS learning_mutations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connected_account_id TEXT NOT NULL DEFAULT '',
      subsystem TEXT NOT NULL,
      trigger TEXT,
      run_id TEXT,
      flag TEXT,
      before_state TEXT NOT NULL,
      after_state TEXT NOT NULL,
      evidence TEXT,
      reverted_at TEXT,
      reverted_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_mutations_lookup
      ON learning_mutations (user_id, connected_account_id, subsystem, created_at);

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
      model TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_turns_user ON chat_turns (user_id, created_at);
    -- client_turn_id (+ its index) is added ONLY by the versioned migration
    -- chat_turns_client_turn_id. Do NOT add migration-era columns or indexes to this
    -- baseline exec: it runs BEFORE applyVersionedMigrations, so on a pre-existing DB
    -- CREATE TABLE IF NOT EXISTS is a no-op and an index referencing a not-yet-ALTERed
    -- column crashes boot ("no such column") — took production down on 2026-07-02.

    CREATE TABLE IF NOT EXISTS llm_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      context TEXT NOT NULL DEFAULT 'unknown',
      key_source TEXT NOT NULL CHECK(key_source IN ('user','operator')),
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      cost_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_user ON llm_usage (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_source ON llm_usage (key_source, created_at);

    CREATE TABLE IF NOT EXISTS rag_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      operation TEXT NOT NULL CHECK(operation IN ('embed','rerank','query','upsert')),
      provider TEXT NOT NULL DEFAULT 'voyage',
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      batch_count INTEGER NOT NULL DEFAULT 1,
      cost_est_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rag_usage_user ON rag_usage (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_rag_usage_op ON rag_usage (operation, created_at);

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
    CREATE TABLE IF NOT EXISTS document_chunks (
      content_hash TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      chunk_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_document_chunks_symbol ON document_chunks (symbol);
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
    CREATE TABLE IF NOT EXISTS learned_context_pending (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('private','shared')),
      kind TEXT NOT NULL CHECK(kind IN ('pattern','decision','fact')),
      subject TEXT NOT NULL,
      symbol TEXT,
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'inferred',
      origin TEXT NOT NULL CHECK(origin IN ('chat','autonomous','ingest')),
      risk_tier TEXT NOT NULL CHECK(risk_tier IN ('risk','strategy-directive')),
      classifier_reason TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      resolved_at TEXT,
      review_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_learned_context_pending_user ON learned_context_pending (user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS socratic_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connected_account_id TEXT,
      run_id TEXT,
      proposal_id TEXT,
      account_number TEXT,
      symbol TEXT,
      side TEXT,
      status TEXT NOT NULL,
      authority TEXT NOT NULL,
      thesis TEXT NOT NULL,
      rationale TEXT NOT NULL,
      green_team_rationale TEXT,
      sizing_snapshot TEXT,
      action TEXT NOT NULL,
      thesis_tag TEXT,
      regime TEXT,
      confidence_score REAL,
      notional REAL,
      model TEXT,
      red_team TEXT,
      policy_decision TEXT,
      evidence TEXT NOT NULL DEFAULT '[]',
      rag_attributions TEXT NOT NULL DEFAULT '[]',
      dissent TEXT NOT NULL DEFAULT '[]',
      outcome TEXT,
      autonomy_override TEXT,
      lessons TEXT NOT NULL DEFAULT '[]',
      coach_notes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_socratic_decisions_user_created ON socratic_decisions (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_socratic_decisions_run ON socratic_decisions (user_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_socratic_decisions_proposal ON socratic_decisions (user_id, proposal_id);

    CREATE TABLE IF NOT EXISTS socratic_framework_proposals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connected_account_id TEXT,
      decision_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      subsystem TEXT NOT NULL,
      title TEXT NOT NULL,
      rationale TEXT NOT NULL,
      proposed_change TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      owner_verb TEXT,
      owner_response TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_socratic_framework_user_status ON socratic_framework_proposals (user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_socratic_framework_run ON socratic_framework_proposals (user_id, run_id);

    CREATE TABLE IF NOT EXISTS api_health_log (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      ts TEXT NOT NULL,
      ok INTEGER NOT NULL CHECK(ok IN (0,1)),
      latency_ms INTEGER,
      error_text TEXT,
      key_source TEXT,
      user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_health_log_service_ts ON api_health_log (service, ts DESC);

    CREATE TABLE IF NOT EXISTS api_health_error_patterns (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      error_text TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      key_source TEXT NOT NULL DEFAULT '',
      UNIQUE(service, fingerprint, key_source)
    );
    CREATE INDEX IF NOT EXISTS idx_api_health_error_patterns_service ON api_health_error_patterns (service, last_seen DESC);

    -- congress.trade (App A) return-path receiver: a local, writable EOD cache that App A's
    -- gap-fill push lands in (POST /api/admin/securities/import). App B's own price history is the
    -- live fetchDailyOHLC cascade, NOT a writable store — these three tables ARE that writable store
    -- so imported closes can warm a cache-aside tier and displace a re-fetch. Keyed ticker+date,
    -- idempotent upsert. 'origin' records who supplied the row (default 'app-a') so a round-trip of
    -- App B's own outbound push is never re-stored. See src/lib/db-securities-import.ts.
    CREATE TABLE IF NOT EXISTS imported_securities_ref (
      ticker TEXT PRIMARY KEY,
      company_name TEXT,
      sector TEXT,
      industry TEXT,
      asset_class TEXT,
      exchange TEXT,
      currency TEXT,
      market_cap REAL,
      cik TEXT,
      origin TEXT NOT NULL DEFAULT 'app-a',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imported_price_eod (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      volume REAL,
      origin TEXT NOT NULL DEFAULT 'app-a',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE INDEX IF NOT EXISTS idx_imported_price_eod_ticker ON imported_price_eod (ticker, date);
    CREATE TABLE IF NOT EXISTS imported_spx_eod (
      date TEXT PRIMARY KEY,
      close REAL NOT NULL,
      volume REAL,
      origin TEXT NOT NULL DEFAULT 'app-a',
      updated_at TEXT NOT NULL
    );

    -- Server-side persistence for a POST /api/strategy/tune review (the paid LLM
    -- proposeStrategyTuning output): previously lived only in client React state, so a closed
    -- browser (or a disconnect before Apply) silently lost it. 'result' is the FULL response JSON
    -- (StrategyTuningProposal plus any appended tuning-invariant warnings). See db-tuning-reviews.ts.
    CREATE TABLE IF NOT EXISTS strategy_tuning_reviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connected_account_id TEXT,
      model TEXT,
      reasoning_effort TEXT,
      generated_by TEXT NOT NULL,
      result TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','applied','dismissed')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_tuning_reviews_user_account_status
      ON strategy_tuning_reviews (user_id, connected_account_id, status);

    -- Generic durable backing store for in-memory rate-limiter / circuit-breaker / cooldown state
    -- (src/lib/durable-state.ts's createDurableMap) that must survive a process restart — the app
    -- now auto-deploys on every merge to main, which replaces the running container mid-session, so
    -- any in-memory guard against a real external cap or a real safety cooldown needs to come back
    -- with its pre-restart state intact rather than resetting to "everything is fresh". One JSON
    -- value per (namespace, key); namespace scopes an owning module (e.g. "provider-request-quota",
    -- "order-remediation-cooldown"), key is that module's own key shape (e.g. "provider|credKey").
    CREATE TABLE IF NOT EXISTS durable_state (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
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
  // Thesis-tag split-brain backfill (2026-07-10 audit fix): insertProposal historically left
  // these columns NULL while the same tags were already embedded in the proposal JSON, so the
  // learning loop's SQL reads saw an empty column even though the data existed. Self-guarding via
  // the WHERE clause (only touches rows still NULL with a JSON value present) -- safe to re-run
  // every startup, no separate "already applied" marker needed.
  database.exec(
    "UPDATE trade_proposals SET trade_thesis_tag = json_extract(proposal, '$.tradeThesisTag') WHERE trade_thesis_tag IS NULL AND json_extract(proposal, '$.tradeThesisTag') IS NOT NULL"
  );
  database.exec(
    "UPDATE trade_proposals SET entry_market_regime = json_extract(proposal, '$.entryMarketRegime') WHERE entry_market_regime IS NULL AND json_extract(proposal, '$.entryMarketRegime') IS NOT NULL"
  );
  // Proposal staleness: when a run's LLM re-validation re-checks a still-pending proposal,
  // stamp when and why it still stands so the queue can show "re-checked X ago" rather than
  // implying an old idea is still freshly recommended.
  if (!columns.some((column) => column.name === "last_revalidated_at")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN last_revalidated_at TEXT");
    database.exec("ALTER TABLE trade_proposals ADD COLUMN revalidation_note TEXT");
  }
  if (!columns.some((column) => column.name === "error_message")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN error_message TEXT");
  }
  // MAE/MFE persistence: add excursion columns to fill_events (additive, guarded).
  const fillEventColumns = database.prepare("PRAGMA table_info(fill_events)").all() as Array<{ name: string }>;
  if (!fillEventColumns.some((c) => c.name === "mae")) {
    database.exec("ALTER TABLE fill_events ADD COLUMN mae REAL");
  }
  if (!fillEventColumns.some((c) => c.name === "mfe")) {
    database.exec("ALTER TABLE fill_events ADD COLUMN mfe REAL");
  }

  // Synthetic-stop refire hardening (2026-07-08 MU incident, round 2): per-row exit-attempt state
  // (additive, guarded). fire_generation counts prior protective-exit attempts whose broker order
  // was POSITIVELY confirmed dead — it is monotonic (advance-only; nothing ever resets it back), and
  // the fire path appends "-g<generation>" to the deterministic client_order_id when it is > 0, so a
  // legitimately re-armed stop places under a fresh id instead of 422-colliding forever with a dead
  // order's id. last_attempt_ref_id remembers the client_order_id of the most recent attempt whose
  // outcome is NOT yet confirmed dead (e.g. placement threw after the broker accepted), so an
  // ambiguous retry reuses it verbatim and the broker's own dedupe fails safe toward a 422 instead
  // of a duplicate protective sell.
  const syntheticStopColumns = database.prepare("PRAGMA table_info(synthetic_trailing_stops)").all() as Array<{ name: string }>;
  if (!syntheticStopColumns.some((c) => c.name === "fire_generation")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN fire_generation INTEGER NOT NULL DEFAULT 0");
  }
  if (!syntheticStopColumns.some((c) => c.name === "last_attempt_ref_id")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN last_attempt_ref_id TEXT");
  }

  // Outcome engine (Wave 2): multi-horizon outcome rows + terminal-unresolvable reason on
  // skipped-candidate counterfactuals (additive, guarded). See docs/rollouts/2026-07-04-w2-outcome-engine.md.
  const skippedCfColumns = database.prepare("PRAGMA table_info(skipped_candidate_counterfactuals)").all() as Array<{ name: string }>;
  if (!skippedCfColumns.some((c) => c.name === "outcomes")) {
    database.exec("ALTER TABLE skipped_candidate_counterfactuals ADD COLUMN outcomes TEXT");
  }
  if (!skippedCfColumns.some((c) => c.name === "resolution_reason")) {
    database.exec("ALTER TABLE skipped_candidate_counterfactuals ADD COLUMN resolution_reason TEXT");
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

  // Per-account state isolation: tag user-level state tables with the connected
  // account they belong to (nullable — account-agnostic rows keep NULL). New per-account
  // state (policy/system_state) lives in account_strategy_state above; these columns let
  // run-state, performance-derived learning, audit and notifications be filtered per account.
  const addAccountColumn = (table: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "connected_account_id")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN connected_account_id TEXT`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_account ON ${table} (user_id, connected_account_id)`);
    }
  };
  for (const table of [
    "strategy_runs",
    "skipped_candidate_counterfactuals",
    "counterfactual_learning_watermarks",
    "audit_events",
    "notification_events"
  ]) {
    addAccountColumn(table);
  }

  // Bind the active account number and policy revision explicitly to the strategy run
  // so retrospective evaluation matches exactly what the run operated against.
  {
    const cols = database.prepare("PRAGMA table_info(strategy_runs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "account_number")) {
      database.exec("ALTER TABLE strategy_runs ADD COLUMN account_number TEXT");
    }
    if (!cols.some((c) => c.name === "policy_revision")) {
      database.exec("ALTER TABLE strategy_runs ADD COLUMN policy_revision TEXT");
    }
  }

  // AI-review advisory column: a single-LLM-call reviewer attaches a per-proposal
  // recommendation (verdict + rationale + optional rewrite) to a pending framework
  // proposal WITHOUT changing the owner verb/status — the owner still makes the final
  // accept/reject/rewrite call. Nullable JSON; absent means "not yet AI-reviewed".
  {
    const cols = database.prepare("PRAGMA table_info(socratic_framework_proposals)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "ai_review")) {
      database.exec("ALTER TABLE socratic_framework_proposals ADD COLUMN ai_review TEXT");
    }
  }

  // Alert lifecycle (2026-07-09): acknowledge state on notification_events, so the Alert Center's
  // "Attention" pill can be cleared instead of growing forever (see docs/rollouts for the
  // triage that motivated this). Additive, guarded — existing rows keep acknowledged_at NULL
  // (unacknowledged) until acted on or resolved by the auto-ack sweep in db-notifications.ts.
  const notificationEventColumns = database.prepare("PRAGMA table_info(notification_events)").all() as Array<{ name: string }>;
  if (!notificationEventColumns.some((c) => c.name === "acknowledged_at")) {
    database.exec("ALTER TABLE notification_events ADD COLUMN acknowledged_at TEXT");
    database.exec("CREATE INDEX IF NOT EXISTS idx_notification_events_unacked ON notification_events (user_id, acknowledged_at)");
  }

  // Per-account watermarks need (user_id, connected_account_id) as the PK, but the original table
  // was created with user_id as the SOLE primary key — a nullable column alone can't express
  // per-account rows. Rebuild it once: the account-agnostic watermark becomes connected_account_id=''
  // (empty string, never NULL, so the composite PK upsert is well-defined). Idempotent — guarded on
  // whether connected_account_id is already part of the PK (pk flag > 0).
  {
    const wmCols = database
      .prepare("PRAGMA table_info(counterfactual_learning_watermarks)")
      .all() as Array<{ name: string; pk: number }>;
    const accountInPk = wmCols.some((c) => c.name === "connected_account_id" && c.pk > 0);
    if (!accountInPk) {
      database.exec(`
        CREATE TABLE counterfactual_learning_watermarks_new (
          user_id TEXT NOT NULL,
          connected_account_id TEXT NOT NULL DEFAULT '',
          last_audit_rowid INTEGER,
          last_audit_created_at TEXT,
          last_audit_id TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, connected_account_id)
        );
        INSERT OR IGNORE INTO counterfactual_learning_watermarks_new
          (user_id, connected_account_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at)
          SELECT user_id, COALESCE(connected_account_id, ''), last_audit_rowid, last_audit_created_at, last_audit_id, updated_at
          FROM counterfactual_learning_watermarks;
        DROP TABLE counterfactual_learning_watermarks;
        ALTER TABLE counterfactual_learning_watermarks_new RENAME TO counterfactual_learning_watermarks;
      `);
    }
  }

  // Rename: legacy "dry_run" proposal status is now "paper".
  database.exec("UPDATE trade_proposals SET status = 'paper' WHERE status = 'dry_run'");

  // Credential-scoped health rows: add key_source + user_id to existing api_health_log tables.
  const healthLogCols = database.prepare("PRAGMA table_info(api_health_log)").all() as Array<{ name: string }>;
  if (healthLogCols.length > 0) {
    if (!healthLogCols.some((c) => c.name === "key_source")) {
      database.exec("ALTER TABLE api_health_log ADD COLUMN key_source TEXT");
    }
    if (!healthLogCols.some((c) => c.name === "user_id")) {
      database.exec("ALTER TABLE api_health_log ADD COLUMN user_id TEXT");
    }
  }
  // Create the composite index unconditionally here — after the column is guaranteed to exist
  // (either from CREATE TABLE on fresh DBs, or from ALTER TABLE above on upgrades).
  // Removed from the main exec block because CREATE TABLE is a no-op on existing tables,
  // so the index ran before ALTER TABLE added the column, causing "no such column: key_source".
  database.exec("CREATE INDEX IF NOT EXISTS idx_api_health_log_service_key ON api_health_log (service, key_source, ts DESC)");
  // api_health_error_patterns: recreate with correct schema when the table predates credential
  // scoping. Two things can be wrong on an existing DB:
  //   (a) key_source column missing entirely, or is TEXT (nullable) instead of TEXT NOT NULL DEFAULT ''
  //   (b) UNIQUE constraint is still (service, fingerprint) — the new ON CONFLICT target
  //       (service, fingerprint, key_source) won't match, so every error-pattern upsert silently
  //       no-ops and failures disappear from the panel.
  // Fix: recreate the table with the correct schema in both cases.
  const healthPatternCols = database.prepare("PRAGMA table_info(api_health_error_patterns)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
  if (healthPatternCols.length > 0) {
    const ksCol = healthPatternCols.find((c) => c.name === "key_source");
    const needsRebuild = !ksCol || ksCol.notnull === 0; // missing or nullable
    if (needsRebuild) {
      // When key_source column is absent, SELECT '''' literal; when nullable column exists use COALESCE.
      // Using COALESCE(key_source, '') on a table without that column raises "no such column".
      const ksExpr = ksCol ? "COALESCE(key_source, '')" : "''";
      database.exec(`
        CREATE TABLE api_health_error_patterns_v2 (
          id TEXT PRIMARY KEY,
          service TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          error_text TEXT NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 1,
          key_source TEXT NOT NULL DEFAULT '',
          UNIQUE(service, fingerprint, key_source)
        );
        INSERT OR IGNORE INTO api_health_error_patterns_v2
          SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, ${ksExpr}
          FROM api_health_error_patterns;
        DROP TABLE api_health_error_patterns;
        ALTER TABLE api_health_error_patterns_v2 RENAME TO api_health_error_patterns;
        CREATE INDEX IF NOT EXISTS idx_api_health_error_patterns_service ON api_health_error_patterns (service, last_seen DESC);
      `);
    }
  }

  // Learning Review "defer" verdict (2026-07-10): the daily reviewer LLM can now leave a pending
  // risk-tier candidate exactly as pending while explaining why it couldn't confidently decide.
  // Additive, guarded — existing rows keep review_note NULL until a review actually defers them.
  const learnedContextPendingColumns = database.prepare("PRAGMA table_info(learned_context_pending)").all() as Array<{ name: string }>;
  if (!learnedContextPendingColumns.some((c) => c.name === "review_note")) {
    database.exec("ALTER TABLE learned_context_pending ADD COLUMN review_note TEXT");
  }

  // Risk cap fix: track when orders were actually placed, not just proposed.
  const tradeProposalColumns = database.prepare("PRAGMA table_info(trade_proposals)").all() as Array<{ name: string }>;
  if (!tradeProposalColumns.some((c) => c.name === "placed_at")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN placed_at TEXT");
  }

  // Account deletion race condition: require a draining state to clear broker lock/fills first.
  const connectedAccountDrainingColumns = database.prepare("PRAGMA table_info(connected_accounts)").all() as Array<{ name: string }>;
  if (!connectedAccountDrainingColumns.some((c) => c.name === "is_draining")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN is_draining INTEGER DEFAULT 0");
  }

  // Exit-strategy Phase A: confirmation-based bad-tick acceptance (suspect_price, suspect_count)
  const syntheticStopCols = database.prepare("PRAGMA table_info(synthetic_trailing_stops)").all() as Array<{ name: string }>;
  if (!syntheticStopCols.some((c) => c.name === "suspect_price")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN suspect_price REAL");
  }
  if (!syntheticStopCols.some((c) => c.name === "suspect_count")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN suspect_count INTEGER NOT NULL DEFAULT 0");
  }

  // Fixed/ATR tick-cadence backstop (Codex review, item 7): fixed/atr stop plans previously had NO
  // protection between strategy runs (excluded from this table entirely — see synthetic-stops.ts).
  // `kind` discriminates a 'trailing' row (extreme ratchets with the high/low-water mark, unchanged
  // behavior) from a 'fixed' row (a static trigger price — the monitor pins extreme_price back to
  // entry_price every tick instead of persisting the ratchet, so the same evaluateStop/fire
  // machinery yields a fixed distance instead of a trail). Defaults existing/legacy rows to
  // 'trailing' (their only prior meaning) so this is purely additive.
  if (!syntheticStopCols.some((c) => c.name === "kind")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN kind TEXT NOT NULL DEFAULT 'trailing'");
  }

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
    ...policyWithoutLegacyFields,
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
  const explicitDailyPct = typeof policyWithoutLegacyFields.maxDailyPctOfNav === "number" && policyWithoutLegacyFields.maxDailyPctOfNav > 0;
  const explicitDailyNotional = typeof policyWithoutLegacyFields.maxDailyNotional === "number" && policyWithoutLegacyFields.maxDailyNotional > 0;
  if (explicitDailyPct) delete merged.maxDailyNotional;
  else if (explicitDailyNotional) delete merged.maxDailyPctOfNav;
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
