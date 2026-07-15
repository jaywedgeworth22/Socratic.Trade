import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RawDatabase from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { estimateReviewNotional } from "../src/lib/alpaca";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-hardening-${randomUUID()}.db`)}`;
});

// ── Migration framework (PRAGMA user_version) ────────────────────────────────
describe("runMigrations — versioned schema migrations", () => {
  it("stamps the baseline, runs newer migrations once in order, and is idempotent", async () => {
    const { runMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    let v2 = 0;
    let v3 = 0;
    const migs = [
      { version: 3, name: "three", up: (d: RawDatabase.Database) => { d.exec("CREATE TABLE t3(x)"); v3++; } },
      { version: 2, name: "two", up: (d: RawDatabase.Database) => { d.exec("CREATE TABLE t2(x)"); v2++; } }
    ];

    expect(runMigrations(db, migs, 1)).toBe(3);
    expect([v2, v3]).toEqual([1, 1]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('t2','t3')").all()).toHaveLength(2);
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(3);

    // Re-run: nothing re-applies.
    expect(runMigrations(db, migs, 1)).toBe(3);
    expect([v2, v3]).toEqual([1, 1]);
    db.close();
  });

  it("applies only migrations newer than the current version", async () => {
    const { runMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    db.pragma("user_version = 2");
    let ran = 0;
    const migs = [
      { version: 2, name: "two", up: () => { ran++; } },
      { version: 4, name: "four", up: (d: RawDatabase.Database) => { d.exec("CREATE TABLE t4(x)"); ran++; } }
    ];
    expect(runMigrations(db, migs, 1)).toBe(4);
    expect(ran).toBe(1); // only v4 ran
    db.close();
  });

  it("purges legacy product Test Accounts through the concrete v25 migration", async () => {
    const {
      applyVersionedMigrations,
      getDb,
      getSchemaVersion,
      listConnectedAccounts,
      upsertConnectedAccount
    } = await import("../src/lib/db");
    const db = getDb();
    expect(getSchemaVersion(db)).toBe(29);
    upsertConnectedAccount({
      id: "legacy-product-test",
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Test Account",
      isActive: true
    });

    // DELETE catches missing account/user columns as well as proving the account itself is removed.
    db.pragma("user_version = 24");
    expect(() => applyVersionedMigrations(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(29);
    expect(listConnectedAccounts("local").some((account) => account.broker === "test")).toBe(false);
  });

  it("migrates only the legacy $500 daily default to 20% of NAV", async () => {
    const { applyVersionedMigrations, getDb, getSchemaVersion } = await import("../src/lib/db");
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT OR REPLACE INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)"
    ).run("cap-default", "cap-default-user", JSON.stringify({ maxDailyNotional: 500 }), now);
    db.prepare(
      "INSERT OR REPLACE INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)"
    ).run("cap-explicit", "cap-explicit-user", JSON.stringify({ maxDailyNotional: 1_000 }), now);

    db.pragma("user_version = 25");
    applyVersionedMigrations(db);
    expect(getSchemaVersion(db)).toBe(29);

    const migrated = JSON.parse((db.prepare("SELECT value FROM user_settings WHERE id = ?").get("cap-default") as { value: string }).value);
    const preserved = JSON.parse((db.prepare("SELECT value FROM user_settings WHERE id = ?").get("cap-explicit") as { value: string }).value);
    expect(migrated).toMatchObject({ maxDailyPctOfNav: 20 });
    expect(migrated.maxDailyNotional).toBeUndefined();
    expect(preserved).toMatchObject({ maxDailyNotional: 1_000 });
    expect(preserved.maxDailyPctOfNav).toBeUndefined();
  });

  it("backstops a legacy settings policy when versioned migrations run before the global copy", async () => {
    const { applyVersionedMigrations, migrateGlobalPolicyToLocalUser } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_settings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE account_strategy_state (policy TEXT NOT NULL);
      CREATE TABLE strategy_profiles (policy TEXT NOT NULL);
      CREATE TABLE socratic_decisions (id TEXT PRIMARY KEY);
    `);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?, ?)").run(
      JSON.stringify({ maxDailyNotional: 500 }),
      now
    );
    db.prepare("INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)").run(
      "legacy-user-policy",
      "legacy-user",
      JSON.stringify({ maxDailyNotional: 500 }),
      now
    );
    db.prepare("INSERT INTO account_strategy_state (policy) VALUES (?)").run(JSON.stringify({ maxDailyNotional: 500 }));
    db.prepare("INSERT INTO strategy_profiles (policy) VALUES (?)").run(JSON.stringify({ maxDailyNotional: 500 }));
    db.pragma("user_version = 25");

    expect(applyVersionedMigrations(db)).toBe(28);

    for (const json of [
      (db.prepare("SELECT value AS json FROM settings WHERE key = 'policy'").get() as { json: string }).json,
      (db.prepare("SELECT value AS json FROM user_settings WHERE id = 'legacy-user-policy'").get() as { json: string }).json,
      (db.prepare("SELECT policy AS json FROM account_strategy_state").get() as { json: string }).json,
      (db.prepare("SELECT policy AS json FROM strategy_profiles").get() as { json: string }).json
    ]) {
      const migrated = JSON.parse(json);
      expect(migrated).toMatchObject({ maxDailyPctOfNav: 20 });
      expect(migrated.maxDailyNotional).toBeUndefined();
    }

    migrateGlobalPolicyToLocalUser(db, now);

    const legacy = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string }).value);
    const copied = JSON.parse((db.prepare("SELECT value FROM user_settings WHERE user_id = 'local' AND key = 'policy'").get() as { value: string }).value);
    expect(legacy).toMatchObject({ maxDailyPctOfNav: 20 });
    expect(legacy.maxDailyNotional).toBeUndefined();
    expect(copied).toEqual(legacy);
    db.close();
  });

  it("does not reinterpret an intentional fixed $500 cap after migration v26", async () => {
    const { applyVersionedMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_settings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE account_strategy_state (policy TEXT NOT NULL);
      CREATE TABLE strategy_profiles (policy TEXT NOT NULL);
      CREATE TABLE socratic_decisions (id TEXT PRIMARY KEY);
    `);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)"
    ).run("cap-intentional-500", "cap-intentional-user", JSON.stringify({ maxDailyNotional: 500 }), now);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?, ?)").run(JSON.stringify({ maxDailyNotional: 500 }), now);
    db.prepare("INSERT INTO account_strategy_state (policy) VALUES (?)").run(JSON.stringify({ maxDailyNotional: 500 }));
    db.prepare("INSERT INTO strategy_profiles (policy) VALUES (?)").run(JSON.stringify({ maxDailyNotional: 500 }));
    db.pragma("user_version = 26");

    expect(applyVersionedMigrations(db)).toBe(28);

    for (const json of [
      (db.prepare("SELECT value AS json FROM settings WHERE key = 'policy'").get() as { json: string }).json,
      (db.prepare("SELECT value AS json FROM user_settings WHERE id = 'cap-intentional-500'").get() as { json: string }).json,
      (db.prepare("SELECT policy AS json FROM account_strategy_state").get() as { json: string }).json,
      (db.prepare("SELECT policy AS json FROM strategy_profiles").get() as { json: string }).json
    ]) {
      const preserved = JSON.parse(json);
      expect(preserved).toMatchObject({ maxDailyNotional: 500 });
      expect(preserved.maxDailyPctOfNav).toBeUndefined();
    }
    expect(
      (db.prepare("PRAGMA table_info(socratic_decisions)").all() as Array<{ name: string }>).map((column) => column.name)
    ).toEqual(expect.arrayContaining(["green_team_rationale", "sizing_snapshot"]));
    db.close();
  });

  it("preserves an explicitly configured large dollar cap instead of treating it as a sentinel", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    const merged = mergePolicy({ ...DEFAULT_POLICY, maxDailyNotional: 750_000, maxDailyPctOfNav: undefined });
    expect(merged.maxDailyNotional).toBe(750_000);
    expect(merged.maxDailyPctOfNav).toBeUndefined();
  });

  it("migrates active replacement uniqueness to user scope and collapses same-user duplicates", async () => {
    const { applyVersionedMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    db.exec(`
      CREATE TABLE order_replacements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_number TEXT NOT NULL,
        original_order_id TEXT NOT NULL,
        status TEXT NOT NULL,
        replacement_order_id TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO order_replacements
        (id, user_id, account_number, original_order_id, status, updated_at)
      VALUES
        ('older', 'user-1', 'ACCOUNT', 'ORDER', 'cancel_requested', '2026-07-14T00:00:00.000Z'),
        ('newer', 'user-1', 'ACCOUNT', 'ORDER', 'replacement_submitted', '2026-07-14T00:01:00.000Z');
    `);
    db.pragma("user_version = 27");

    expect(applyVersionedMigrations(db)).toBe(28);
    expect(db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM order_replacements
      WHERE user_id = 'user-1' AND account_number = 'ACCOUNT' AND original_order_id = 'ORDER'
      GROUP BY status
      ORDER BY status
    `).all()).toEqual([
      { status: "failed", count: 1 },
      { status: "replacement_submitted", count: 1 }
    ]);

    expect(() => db.prepare(`
      INSERT INTO order_replacements
        (id, user_id, account_number, original_order_id, status, updated_at)
      VALUES ('cross-user', 'user-2', 'ACCOUNT', 'ORDER', 'cancel_requested', '2026-07-14T00:02:00.000Z')
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      INSERT INTO order_replacements
        (id, user_id, account_number, original_order_id, status, updated_at)
      VALUES ('same-user', 'user-1', 'ACCOUNT', 'ORDER', 'cancel_requested', '2026-07-14T00:03:00.000Z')
    `).run()).toThrow();
    db.close();
  });
});

// ── ENCRYPTION_KEY fail-fast ─────────────────────────────────────────────────
describe("encryption-key boot guard", () => {
  it("detects ciphertext and fails fast only when the key is ephemeral and not under test", async () => {
    const { getDb, upsertConnectedAccount, hasEncryptedCredentials, assertEncryptionKeyAvailable } = await import("../src/lib/db");
    const db = getDb();

    expect(hasEncryptedCredentials(db)).toBe(false);
    expect(() => assertEncryptionKeyAvailable(db, { ephemeral: true, isTest: false })).not.toThrow();

    upsertConnectedAccount({
      id: randomUUID(),
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST",
      label: "Test",
      apiKey: "super-secret-key",
      isActive: true
    });
    expect(hasEncryptedCredentials(db)).toBe(true);

    expect(() => assertEncryptionKeyAvailable(db, { ephemeral: true, isTest: false })).toThrow(/ENCRYPTION_KEY is not set/);
    expect(() => assertEncryptionKeyAvailable(db, { ephemeral: false, isTest: false })).not.toThrow();
    expect(() => assertEncryptionKeyAvailable(db, { ephemeral: true, isTest: true })).not.toThrow();
  });
});

// ── Alpaca review notional (no fabricated $100) ──────────────────────────────
describe("estimateReviewNotional — never fabricates a price", () => {
  it("uses dollarAmount directly", () => {
    expect(estimateReviewNotional({ dollarAmount: 2500, quantity: 9 }, undefined).estimatedNotional).toBe(2500);
  });
  it("uses quantity * (limit ?? stop ?? quote)", () => {
    expect(estimateReviewNotional({ quantity: 10, limitPrice: 50 }, 999).estimatedNotional).toBe(500);
    expect(estimateReviewNotional({ quantity: 10, stopPrice: 40 }, 999).estimatedNotional).toBe(400);
    expect(estimateReviewNotional({ quantity: 10 }, 30).estimatedNotional).toBe(300);
  });
  it("fails CLOSED (over-cap + alert) when no price is available for an OPENING order — never $100", () => {
    // Opening orders (buy/short, or unspecified side) keep the over-cap sentinel: an un-sizable open is blocked.
    const r = estimateReviewNotional({ quantity: 500 }, undefined);
    expect(r.estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
    expect(r.estimatedNotional).not.toBe(50000);
    expect(r.alerts.length).toBeGreaterThan(0);
    expect(estimateReviewNotional({ quantity: 500 }, 0).estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
    expect(estimateReviewNotional({ side: "buy", quantity: 500 }, undefined).estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
    expect(estimateReviewNotional({ side: "short", quantity: 500 }, undefined).estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("does NOT use the over-cap sentinel for an EXIT with no price — returns 0 (exits aren't notional-capped)", () => {
    // Regression: a risk-exit SELL/cover with no live quote previously got MAX_SAFE_INTEGER, which
    // corrupted the displayed notional (~$9 quadrillion) and the net-exposure projection, blocking the exit.
    for (const side of ["sell", "cover"] as const) {
      const r = estimateReviewNotional({ side, quantity: 500 }, undefined);
      expect(r.estimatedNotional).toBe(0);
      expect(r.estimatedNotional).not.toBe(Number.MAX_SAFE_INTEGER);
      expect(r.alerts.length).toBeGreaterThan(0);
    }
  });

  it("falls back to referencePrice for an exit when the live quote is missing", () => {
    // The entry anchor is a real captured price (not fabricated), good enough for an exempt exit's display.
    expect(estimateReviewNotional({ side: "sell", quantity: 10, referencePrice: 42 }, undefined).estimatedNotional).toBe(420);
    // Opening orders do NOT use referencePrice — an un-sizable open must still fail closed.
    expect(estimateReviewNotional({ side: "buy", quantity: 10, referencePrice: 42 }, undefined).estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
    // A live quote / explicit order price still wins over the anchor for an exit.
    expect(estimateReviewNotional({ side: "sell", quantity: 10, referencePrice: 42 }, 50).estimatedNotional).toBe(500);
  });
});

// ── Policy: universe/blocklist gate is opening-only (exits always allowed) ────
describe("evaluateTradeProposal — universe gate skips exits", () => {
  const portfolio: Portfolio = { accountNumber: "A1", totalMarketValue: 10000, buyingPower: 5000, equityMarketValue: 5000, optionMarketValue: 0, cash: 5000 };
  const positions: EquityPosition[] = [{ symbol: "MSFT", quantity: 5, averageCost: 200, marketValue: 1000, sector: "Technology" }];
  const policy: TradingPolicy = {
    ...DEFAULT_POLICY,
    systemState: "active",
    strategyAuthority: "decide",
    accountNumber: "A1",
    includedIndices: [],
    additionalSymbols: ["AAPL"] // MSFT deliberately NOT in the allowed universe
  };
  const base = { type: "market" as const, timeInForce: "gfd" as const, marketHours: "regular_hours" as const, rationale: "t", tradeThesisTag: "t", entryMarketRegime: "t" };
  const ctx = { policy, portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 100 };
  const universeReason = (d: { reasons?: string[] }) => (d.reasons ?? []).some((r) => r.includes("not in the allowed universe"));

  it("blocks an opening BUY of an out-of-universe symbol", () => {
    const buy: TradeProposal = { ...base, symbol: "MSFT", side: "buy", quantity: 5 };
    expect(universeReason(evaluateTradeProposal(buy, ctx))).toBe(true);
  });

  it("does NOT block an exit SELL of the same out-of-universe symbol", () => {
    const sell: TradeProposal = { ...base, symbol: "MSFT", side: "sell", quantity: 5 };
    expect(universeReason(evaluateTradeProposal(sell, ctx))).toBe(false);
  });
});
