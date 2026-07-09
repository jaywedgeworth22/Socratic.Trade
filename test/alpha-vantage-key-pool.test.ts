import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlphaVantageKeyPool,
  getPoolForKeys,
  isAlphaVantageDailyCapMessage,
  millisUntilNextAlphaVantageDailyReset,
  __resetKeyPoolRegistryForTests
} from "../src/lib/alpha-vantage-key-pool";
import { resolveAlphaVantageKeyPool } from "../src/lib/db-api-keys";

// Isolated temp SQLite DB per this test file (per repo convention — see beforeAll in
// test/data-providers.test.ts) so db module singleton state (the persisted exhaustion
// setting) never leaks into/out of other test files.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpha-vantage-key-pool-${randomUUID()}.db`)}`;
});

// ── isAlphaVantageDailyCapMessage — the daily-cap vs burst-warning discriminator ──────────

describe("isAlphaVantageDailyCapMessage", () => {
  it("matches Alpha Vantage's genuine daily-cap message (verbatim prod sample)", () => {
    // Captured from a real 2026-07-08 prod api_health_log row (post-scrub-deploy the key
    // itself reads ***, but the surrounding phrase is verbatim).
    const capMessage =
      "We have detected your API key as *** and our standard API rate limit is 25 requests per day, 5 calls per minute and 100 calls per month. Please visit https://www.alphavantage.co/premium/ if you would like to target a higher API call frequency.";
    expect(isAlphaVantageDailyCapMessage(capMessage)).toBe(true);
  });

  it("does NOT match the transient burst-warning message (verbatim prod sample)", () => {
    // The burst warning mentions the same "25 requests per day" figure as part of its upsell
    // pitch but never contains "detected your API key" — this is the exact discriminator that
    // must not produce a false positive (a false positive here would wrongly rotate away from
    // a perfectly healthy key on a transient warning the 1.1s pacer already handles).
    const burstMessage =
      "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second) to avoid hitting our API rate limit. Or subscribe to our premium plans at https://www.alphavantage.co/premium/ to instantaneously remove all daily rate limits and lift the free key rate limit (25 requests per day) as well.";
    expect(isAlphaVantageDailyCapMessage(burstMessage)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isAlphaVantageDailyCapMessage("WE HAVE DETECTED YOUR API KEY AS ABC123")).toBe(true);
  });

  it("does not match unrelated error text", () => {
    expect(isAlphaVantageDailyCapMessage("HTTP 500 Internal Server Error")).toBe(false);
  });
});

// ── millisUntilNextAlphaVantageDailyReset — DST-safe reset-instant computation ────────────

describe("millisUntilNextAlphaVantageDailyReset", () => {
  const originalTz = process.env.ALPHAVANTAGE_RESET_TZ;
  const originalHour = process.env.ALPHAVANTAGE_RESET_HOUR;

  beforeEach(() => {
    delete process.env.ALPHAVANTAGE_RESET_TZ;
    delete process.env.ALPHAVANTAGE_RESET_HOUR;
  });

  afterEach(() => {
    if (originalTz !== undefined) process.env.ALPHAVANTAGE_RESET_TZ = originalTz;
    else delete process.env.ALPHAVANTAGE_RESET_TZ;
    if (originalHour !== undefined) process.env.ALPHAVANTAGE_RESET_HOUR = originalHour;
    else delete process.env.ALPHAVANTAGE_RESET_HOUR;
  });

  it("returns ms until next America/New_York midnight (default assumption)", () => {
    // 2026-07-08T20:00:00Z = 16:00 EDT (UTC-4, summer) -> 8h until next ET midnight.
    const fromMs = Date.parse("2026-07-08T20:00:00Z");
    expect(millisUntilNextAlphaVantageDailyReset(fromMs)).toBe(8 * 60 * 60_000);
  });

  it("is DST-safe across the US spring-forward transition (2026-03-08, EST->EDT)", () => {
    // 2026-03-07T17:00:00Z = 12:00 noon EST (UTC-5, still standard time) the day before the
    // transition. Next ET midnight (2026-03-08 00:00, still EST — the 2am jump hasn't
    // happened yet) = 2026-03-08T05:00:00Z -> 12h away.
    const fromMs = Date.parse("2026-03-07T17:00:00Z");
    expect(millisUntilNextAlphaVantageDailyReset(fromMs)).toBe(12 * 60 * 60_000);
  });

  it("is DST-safe across the US fall-back transition (2026-11-01, EDT->EST)", () => {
    // 2026-10-31T16:00:00Z = 12:00 noon EDT (UTC-4, still daylight time) the day before the
    // transition. Next ET midnight (2026-11-01 00:00, still EDT — the 2am fallback hasn't
    // happened yet) = 2026-11-01T04:00:00Z -> 12h away.
    const fromMs = Date.parse("2026-10-31T16:00:00Z");
    expect(millisUntilNextAlphaVantageDailyReset(fromMs)).toBe(12 * 60 * 60_000);
  });

  it("honors ALPHAVANTAGE_RESET_TZ / ALPHAVANTAGE_RESET_HOUR overrides", () => {
    process.env.ALPHAVANTAGE_RESET_TZ = "UTC";
    process.env.ALPHAVANTAGE_RESET_HOUR = "6";
    const fromMs = Date.parse("2026-07-08T02:00:00Z");
    expect(millisUntilNextAlphaVantageDailyReset(fromMs)).toBe(4 * 60 * 60_000);
  });

  it("returns exactly 24h when fromMs is precisely at the reset instant", () => {
    process.env.ALPHAVANTAGE_RESET_TZ = "UTC";
    process.env.ALPHAVANTAGE_RESET_HOUR = "0";
    const fromMs = Date.parse("2026-07-08T00:00:00Z");
    expect(millisUntilNextAlphaVantageDailyReset(fromMs)).toBe(24 * 60 * 60_000);
  });
});

// ── AlphaVantageKeyPool — configure diffing, rotation, exhaustion, persistence ────────────

describe("AlphaVantageKeyPool", () => {
  describe("configure", () => {
    it("is idempotent value-diff, not a blind replace: preserves exhaustedUntil across repeated calls with the same keys", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-b"]);
      const now = 1_000_000;
      pool.markExhausted("key-a", now);
      expect(pool.allExhausted(now)).toBe(false); // key-b still alive

      // Re-configure with the SAME key list (simulates getEnrichmentProvider() rebuilding the
      // provider on the next scan) — must NOT wipe key-a's exhaustion memory.
      pool.configure(["key-a", "key-b"]);
      const currentAfterReconfigure = pool.currentKey(now);
      expect(currentAfterReconfigure?.key).toBe("key-b"); // key-a still exhausted, so key-b serves
    });

    it("drops keys no longer present and adds new ones without disturbing survivors", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-b"]);
      pool.markExhausted("key-a", 1_000_000);

      pool.configure(["key-a", "key-c"]); // key-b dropped, key-c added
      expect(pool.allKeys().sort()).toEqual(["key-a", "key-c"].sort());
      // key-a's exhaustion memory survives the reconfigure (still present in the new list).
      expect(pool.currentKey(1_000_000)?.key).toBe("key-c");
    });

    it("de-dupes keys defensively", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-a", "key-b"]);
      expect(pool.size()).toBe(2);
    });
  });

  describe("rotation", () => {
    it("stays sticky on the current key until markExhausted is called", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-b", "key-c"]);
      const now = 1_000_000;
      expect(pool.currentKey(now)?.key).toBe("key-a");
      expect(pool.currentKey(now)?.key).toBe("key-a"); // still sticky, unchanged
    });

    it("rotates to the next non-exhausted key (wrapping) only after markExhausted", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-b", "key-c"]);
      const now = 1_000_000;
      pool.markExhausted("key-a", now);
      expect(pool.currentKey(now)?.key).toBe("key-b");
      pool.markExhausted("key-b", now);
      expect(pool.currentKey(now)?.key).toBe("key-c");
      pool.markExhausted("key-c", now);
      // All exhausted now — allExhausted() must gate callers before they'd reach this branch,
      // but currentKey() still returns the earliest-to-recover key rather than undefined.
      expect(pool.allExhausted(now)).toBe(true);
      expect(pool.currentKey(now)).toBeDefined();
    });

    it("does NOT rotate on a burst-warning-shaped message (only markExhausted triggers rotation, and callers must only call it on the daily-cap discriminator)", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-b"]);
      const now = 1_000_000;
      const burstMessage = "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second)...";
      // Simulates the provider's own guard: only call markExhausted when the discriminator matches.
      if (isAlphaVantageDailyCapMessage(burstMessage)) pool.markExhausted("key-a", now);
      expect(pool.currentKey(now)?.key).toBe("key-a"); // unchanged — sticky key survives a burst warning
    });

    it("returns the earliest-to-recover key when all keys are exhausted, without advancing the sticky pointer", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-b"]);
      pool.markExhausted("key-a", 1_000_000); // exhausted until 1_000_000 + resetDelay(a)
      pool.markExhausted("key-b", 2_000_000); // exhausted until 2_000_000 + resetDelay(b) (later)
      const probeNow = 3_000_000;
      expect(pool.allExhausted(probeNow)).toBe(true);
      // key-a was marked exhausted first (earlier `now`), so its exhaustedUntil is earlier —
      // it should be the one returned as "next to come back alive".
      expect(pool.currentKey(probeNow)?.key).toBe("key-a");
    });
  });

  describe("allExhausted / fast-fail signal", () => {
    it("is false for an empty pool (never claims exhaustion with zero keys)", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure([]);
      expect(pool.allExhausted()).toBe(false);
    });

    it("is false while at least one key is usable", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-b"]);
      pool.markExhausted("key-a", 1_000_000);
      expect(pool.allExhausted(1_000_000)).toBe(false);
    });

    it("is true only once every key is exhausted", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a", "key-b"]);
      pool.markExhausted("key-a", 1_000_000);
      pool.markExhausted("key-b", 1_000_000);
      expect(pool.allExhausted(1_000_000)).toBe(true);
    });

    it("recovers (allExhausted -> false) once the exhaustion window has passed", () => {
      const pool = new AlphaVantageKeyPool();
      pool.configure(["key-a"]);
      const markedAt = 1_000_000;
      pool.markExhausted("key-a", markedAt);
      expect(pool.allExhausted(markedAt)).toBe(true);
      const recoveredAt = markedAt + millisUntilNextAlphaVantageDailyReset(markedAt) + 1;
      expect(pool.allExhausted(recoveredAt)).toBe(false);
    });
  });

  describe("persistence (exhausted-until survives a fresh AlphaVantageKeyPool instance)", () => {
    it("persists markExhausted across a NEW pool instance configured with the same key (simulates a process restart)", () => {
      const now = Date.now();
      const poolA = new AlphaVantageKeyPool();
      poolA.configure(["restart-test-key", "restart-test-key-2"]);
      poolA.markExhausted("restart-test-key", now);
      expect(poolA.currentKey(now)?.key).toBe("restart-test-key-2");

      // A brand-new instance (simulating a fresh process) configured with the SAME keys must
      // pick up the persisted exhaustion via the internal setting, not re-probe the dead key.
      const poolB = new AlphaVantageKeyPool();
      poolB.configure(["restart-test-key", "restart-test-key-2"]);
      expect(poolB.currentKey(now)?.key).toBe("restart-test-key-2");
      expect(poolB.allExhausted(now)).toBe(false);
    });

    it("does not resurrect an EXPIRED persisted exhaustion into a fresh instance", () => {
      const past = 1_000_000;
      const poolA = new AlphaVantageKeyPool();
      poolA.configure(["expired-test-key"]);
      poolA.markExhausted("expired-test-key", past);

      // Long after the reset window has passed, a fresh instance configured with this key
      // should treat it as usable again (persisted exhaustedUntil <= now).
      const farFuture = past + millisUntilNextAlphaVantageDailyReset(past) + 10_000;
      const poolB = new AlphaVantageKeyPool();
      poolB.configure(["expired-test-key"]);
      expect(poolB.allExhausted(farFuture)).toBe(false);
      expect(poolB.currentKey(farFuture)?.key).toBe("expired-test-key");
    });
  });
});

// ── resolveAlphaVantageKeyPool (db-api-keys.ts) — env parsing / fallback / dedupe ─────────

describe("resolveAlphaVantageKeyPool", () => {
  const originalPlural = process.env.ALPHAVANTAGE_API_KEYS;
  const originalSingular = process.env.ALPHAVANTAGE_API_KEY;

  beforeEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEYS;
    delete process.env.ALPHAVANTAGE_API_KEY;
  });

  afterEach(() => {
    if (originalPlural !== undefined) process.env.ALPHAVANTAGE_API_KEYS = originalPlural;
    else delete process.env.ALPHAVANTAGE_API_KEYS;
    if (originalSingular !== undefined) process.env.ALPHAVANTAGE_API_KEY = originalSingular;
    else delete process.env.ALPHAVANTAGE_API_KEY;
  });

  it("returns an empty pool (source 'none') when neither env var is set and no user key exists", () => {
    const resolved = resolveAlphaVantageKeyPool();
    expect(resolved).toEqual({ keys: [], source: "none", envVar: "ALPHAVANTAGE_API_KEY" });
  });

  it("falls back to the singular ALPHAVANTAGE_API_KEY as a one-item pool (backward compat)", () => {
    process.env.ALPHAVANTAGE_API_KEY = "single-key-value";
    const resolved = resolveAlphaVantageKeyPool();
    expect(resolved).toEqual({ keys: ["single-key-value"], source: "env", envVar: "ALPHAVANTAGE_API_KEY" });
  });

  it("parses the plural ALPHAVANTAGE_API_KEYS, trimming whitespace", () => {
    process.env.ALPHAVANTAGE_API_KEYS = " key-1 , key-2 ,key-3";
    const resolved = resolveAlphaVantageKeyPool();
    expect(resolved).toEqual({ keys: ["key-1", "key-2", "key-3"], source: "env", envVar: "ALPHAVANTAGE_API_KEYS" });
  });

  it("dedupes the plural list while preserving first-seen order", () => {
    process.env.ALPHAVANTAGE_API_KEYS = "key-1,key-2,key-1,key-3,key-2";
    const resolved = resolveAlphaVantageKeyPool();
    expect(resolved.keys).toEqual(["key-1", "key-2", "key-3"]);
  });

  it("drops empty entries from the plural list (trailing/double commas)", () => {
    process.env.ALPHAVANTAGE_API_KEYS = "key-1,,key-2,";
    const resolved = resolveAlphaVantageKeyPool();
    expect(resolved.keys).toEqual(["key-1", "key-2"]);
  });

  it("prefers the plural list over the singular fallback when both are set", () => {
    process.env.ALPHAVANTAGE_API_KEYS = "key-1,key-2";
    process.env.ALPHAVANTAGE_API_KEY = "single-key-value";
    const resolved = resolveAlphaVantageKeyPool();
    expect(resolved).toEqual({ keys: ["key-1", "key-2"], source: "env", envVar: "ALPHAVANTAGE_API_KEYS" });
  });
});

// ── AlphaVantageEnrichmentProvider integration: rotation, scrub, all-exhausted fast-fail ──

describe("AlphaVantageEnrichmentProvider multi-key integration", () => {
  const originalRateLimitDisabled = process.env.PROVIDER_RATE_LIMIT_DISABLED;
  const originalCircuitBreakerDisabled = process.env.API_CIRCUIT_BREAKER_DISABLED;

  beforeEach(() => {
    // Isolate from real-world pacing/circuit-breaker behavior — mirrors test/data-providers.test.ts.
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  });

  afterEach(() => {
    if (originalRateLimitDisabled !== undefined) process.env.PROVIDER_RATE_LIMIT_DISABLED = originalRateLimitDisabled;
    else delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
    if (originalCircuitBreakerDisabled !== undefined) process.env.API_CIRCUIT_BREAKER_DISABLED = originalCircuitBreakerDisabled;
    else delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    vi.unstubAllGlobals();
  });

  it("rotates to the 2nd key after the 1st hits the genuine daily-cap message, and does not rotate on the burst warning", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    const pool = new AlphaVantageKeyPool();
    // Unique key literals per test (never reused elsewhere in this file) — exhaustion is
    // persisted keyed by a fingerprint of the literal key value across the whole test file's
    // shared temp DB, so reusing a key string across tests would leak exhaustion state between
    // them (a fresh AlphaVantageKeyPool still consults the persisted setting on configure()).
    const KEY_1 = "rotate-cap-key-1";
    const KEY_2 = "rotate-cap-key-2";

    const requestedKeys: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const key = new URL(url).searchParams.get("apikey") ?? "";
      requestedKeys.push(key);
      if (key === KEY_1) {
        return new Response(JSON.stringify({
          Note: `We have detected your API key as ${KEY_1} and our standard API rate limit is 25 requests per day...`
        }));
      }
      return new Response(JSON.stringify({ feed: [] }));
    });

    const provider = new AlphaVantageEnrichmentProvider([KEY_1, KEY_2], "env", undefined, pool);
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({});
    expect(requestedKeys).toEqual([KEY_1]);

    // key-1 is now exhausted — the NEXT call must dispatch on key-2 without a fresh provider
    // instance (mirrors getEnrichmentProvider() reconstructing per scan, but this proves
    // rotation persists within/after the pool's own state).
    const res2 = await provider.enrich(["MSFT"]);
    expect(requestedKeys).toEqual([KEY_1, KEY_2]);
    expect(res2.MSFT).toEqual({});
  });

  it("does not rotate on a burst-warning-shaped Note (same key keeps serving)", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    const pool = new AlphaVantageKeyPool();
    const KEY_1 = "rotate-burst-key-1";
    const KEY_2 = "rotate-burst-key-2";

    const requestedKeys: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const key = new URL(url).searchParams.get("apikey") ?? "";
      requestedKeys.push(key);
      return new Response(JSON.stringify({
        Note: "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second)..."
      }));
    });

    const provider = new AlphaVantageEnrichmentProvider([KEY_1, KEY_2], "env", undefined, pool);
    await provider.enrich(["AAPL"]);
    await provider.enrich(["MSFT"]);
    // Both calls dispatched on key-1 — the burst warning must never trigger rotation.
    expect(requestedKeys).toEqual([KEY_1, KEY_1]);
  });

  it("short-circuits (no fetch calls) once every pool key is exhausted, logging one health row per enrich() call, not N", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { getServiceHealthLog } = await import("../src/lib/db-health");
    clearEnrichmentCache();
    const pool = new AlphaVantageKeyPool();
    pool.configure(["dead-key"]);
    pool.markExhausted("dead-key", Date.now());

    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({ feed: [] }));
    });

    const provider = new AlphaVantageEnrichmentProvider(["dead-key"], "env", undefined, pool);
    const res = await provider.enrich(["AAPL", "MSFT", "GOOG", "NVDA", "AMZN", "TSLA"]); // > CONCURRENCY (5)
    expect(fetchCount).toBe(0); // no per-symbol dispatch at all
    for (const symbol of ["AAPL", "MSFT", "GOOG", "NVDA", "AMZN", "TSLA"]) {
      expect(res[symbol]).toEqual({});
    }

    const rows = getServiceHealthLog("alpha-vantage", 20);
    const exhaustionRows = rows.filter((r) => (r.error_text ?? "").includes("entire key pool exhausted"));
    expect(exhaustionRows.length).toBe(1); // exactly one row for this whole enrich() call, not six
  });

  it("scrubs EVERY pool key from the warning/error text, including a non-dispatching pool member's key if echoed", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { getServiceHealthLog } = await import("../src/lib/db-health");
    clearEnrichmentCache();
    const pool = new AlphaVantageKeyPool();

    const dispatchingKey = "DISPATCHING_SECRET_KEY";
    const otherPoolKey = "OTHER_POOL_SECRET_KEY";
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({
        // Simulates AV echoing a DIFFERENT pool member's key in the message text — a scenario
        // never observed in prod but explicitly guarded against (see scrubProviderErrorTextForPool).
        Note: `Thank you for using Alpha Vantage! See ${dispatchingKey} and ${otherPoolKey} for details.`
      }));
    });

    const provider = new AlphaVantageEnrichmentProvider([dispatchingKey, otherPoolKey], "env", undefined, pool);
    await provider.enrich(["AAPL"]);

    const rows = getServiceHealthLog("alpha-vantage", 5);
    const errorTexts = rows.map((r) => r.error_text).filter((t): t is string => typeof t === "string");
    expect(errorTexts.length).toBeGreaterThan(0);
    for (const text of errorTexts) {
      expect(text).not.toContain(dispatchingKey);
      expect(text).not.toContain(otherPoolKey);
    }
  });

  it("backward compat: a bare single-string key (no array) still produces a working one-item pool", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({
        feed: [{ title: "AAPL headline", ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.1" }] }]
      }));
    });

    // NOT wrapped in an array — mirrors every pre-existing call site (see
    // test/data-providers.test.ts's "Alpha Vantage Warning Detection" suite).
    const provider = new AlphaVantageEnrichmentProvider("bare-string-key");
    const res = await provider.enrich(["AAPL"]);
    expect(fetchCount).toBe(1);
    expect(res.AAPL.headlines).toEqual(["AAPL headline"]);
  });
});

// ── getPoolForKeys — per-key-set pool registry (replaces the reconfigure-the-singleton bug) ──
//
// Root cause this covers (2026-07-09): a single mutable `defaultAlphaVantageKeyPool` used to be
// reconfigured wholesale by EVERY AlphaVantageEnrichmentProvider construction, so a per-user
// stored key (e.g. pool [U]) constructed mid-scan would wipe the scheduler's env-key pool (e.g.
// [E1, E2]) rotation/exhaustion state, and vice versa. getPoolForKeys fixes this by keying a
// registry off the exact SET of keys so distinct key sets get distinct, coexisting pools.

describe("getPoolForKeys", () => {
  const originalRateLimitDisabled = process.env.PROVIDER_RATE_LIMIT_DISABLED;
  const originalCircuitBreakerDisabled = process.env.API_CIRCUIT_BREAKER_DISABLED;

  beforeEach(() => {
    __resetKeyPoolRegistryForTests();
    // Isolate the "integration" sub-test's real enrich() calls from real-world pacing AND from
    // the per-lane circuit breaker possibly already tripped by earlier failing "alpha-vantage"/
    // "env" calls elsewhere in this same file's shared temp DB (mirrors the pattern used by the
    // "AlphaVantageEnrichmentProvider multi-key integration" describe block above).
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  });

  afterEach(() => {
    if (originalRateLimitDisabled !== undefined) process.env.PROVIDER_RATE_LIMIT_DISABLED = originalRateLimitDisabled;
    else delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
    if (originalCircuitBreakerDisabled !== undefined) process.env.API_CIRCUIT_BREAKER_DISABLED = originalCircuitBreakerDisabled;
    else delete process.env.API_CIRCUIT_BREAKER_DISABLED;
    vi.unstubAllGlobals();
  });

  it("returns the SAME pool instance for the same key set, regardless of argument order", () => {
    const poolA = getPoolForKeys(["reg-key-1", "reg-key-2"]);
    const poolB = getPoolForKeys(["reg-key-2", "reg-key-1"]); // same set, different order
    expect(poolB).toBe(poolA);
  });

  it("returns DISTINCT pool instances for distinct key sets, coexisting without cross-contamination", () => {
    const now = 5_000_000;

    // Scheduler's env-key pool [E1, E2]...
    const schedulerPool = getPoolForKeys(["reg-env-key-1", "reg-env-key-2"]);
    // ...and a per-user stored key pool [U], constructed mid-scan with a totally different set.
    const userPool = getPoolForKeys(["reg-user-key-1"]);
    expect(userPool).not.toBe(schedulerPool);

    // Exhaust E1 in the scheduler pool.
    schedulerPool.markExhausted("reg-env-key-1", now);
    expect(schedulerPool.allExhausted(now)).toBe(false); // E2 still alive
    expect(userPool.allExhausted(now)).toBe(false); // [U] must be completely unaffected

    // Re-resolving the scheduler's pool for the SAME key set (simulates the next scan) must
    // return the SAME instance with E1's exhaustion memory intact.
    const schedulerPoolAgain = getPoolForKeys(["reg-env-key-1", "reg-env-key-2"]);
    expect(schedulerPoolAgain).toBe(schedulerPool);
    expect(schedulerPoolAgain.currentKey(now)?.key).toBe("reg-env-key-2");

    // [U] must still be untouched.
    const userPoolAgain = getPoolForKeys(["reg-user-key-1"]);
    expect(userPoolAgain).toBe(userPool);
    expect(userPoolAgain.allExhausted(now)).toBe(false);
  });

  it("integration: providers constructed WITHOUT an explicit pool (production default path) resolve via getPoolForKeys — distinct key sets never cross-contaminate", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const ENV_KEY_1 = "integration-env-key-1"; // gitleaks:allow — obviously-fake test fixture, not a credential
    const ENV_KEY_2 = "integration-env-key-2"; // gitleaks:allow — obviously-fake test fixture, not a credential
    const USER_KEY = "integration-user-key-1"; // gitleaks:allow — obviously-fake test fixture, not a credential
    const requestedKeys: string[] = [];

    vi.stubGlobal("fetch", async (url: string) => {
      const key = new URL(url).searchParams.get("apikey") ?? "";
      requestedKeys.push(key);
      if (key === ENV_KEY_1) {
        return new Response(JSON.stringify({
          Note: `We have detected your API key as ${ENV_KEY_1} and our standard API rate limit is 25 requests per day...`
        }));
      }
      return new Response(JSON.stringify({ feed: [] }));
    });

    // Scheduler's env-key pool [E1, E2] — no explicit pool arg (the real production call shape
    // used by getEnrichmentProvider()).
    const schedulerProvider = new AlphaVantageEnrichmentProvider([ENV_KEY_1, ENV_KEY_2], "env");
    await schedulerProvider.enrich(["AAPL"]); // exhausts E1 via the daily-cap message

    // A per-user pool [U], constructed mid-scan with a totally different key set — must dispatch
    // normally on its own key, unaffected by E1's exhaustion (the exact bug this fix replaces).
    const userProvider = new AlphaVantageEnrichmentProvider([USER_KEY], "user", "integration-user");
    await userProvider.enrich(["MSFT"]);

    // A FRESH scheduler-pool provider for the SAME [E1, E2] set must still see E1 dead and go
    // straight to E2 — proves the pool persisted in the registry rather than being reconfigured
    // from scratch (or clobbered by the [U] construction in between).
    const schedulerAgain = new AlphaVantageEnrichmentProvider([ENV_KEY_1, ENV_KEY_2], "env");
    await schedulerAgain.enrich(["GOOG"]);

    expect(requestedKeys).toEqual([ENV_KEY_1, USER_KEY, ENV_KEY_2]);
  });
});

// ── Mid-chunk fast-stop (FIX 3): per-symbol allExhausted() re-check at actual dispatch time ──

describe("AlphaVantageEnrichmentProvider mid-chunk fast-stop", () => {
  const originalCircuitBreakerDisabled = process.env.API_CIRCUIT_BREAKER_DISABLED;

  afterEach(() => {
    if (originalCircuitBreakerDisabled !== undefined) process.env.API_CIRCUIT_BREAKER_DISABLED = originalCircuitBreakerDisabled;
    else delete process.env.API_CIRCUIT_BREAKER_DISABLED;
  });

  it("stops dispatching remaining symbols in the SAME chunk once the pool exhausts mid-chunk", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { resetProviderRateLimiterState } = await import("../src/lib/provider-rate-limit");
    clearEnrichmentCache();
    const pool = new AlphaVantageKeyPool();
    const KEY_1 = "midchunk-key-1"; // gitleaks:allow — obviously-fake test fixture, not a credential
    const KEY_2 = "midchunk-key-2"; // gitleaks:allow — obviously-fake test fixture, not a credential

    // Force TRUE serial dispatch: alpha-vantage's real pacer default (provider-rate-limit.ts's
    // HARD_DEFAULTS) is concurrency: 1 — the min-interval spacing is overridden to a SMALL but
    // NON-ZERO value (not 0, and not real production's 1.1s) here. It must be non-zero: the
    // pacer's concurrency slot frees as soon as the raw `fetchWithRetry` call resolves (inside
    // withProviderLimit's callback) — BEFORE this provider's own JSON-parsing/cap-message-
    // detection/markExhausted step, which runs in the OUTER per-symbol code AFTER
    // withProviderLimit already returned. With a 0ms interval the next symbol can get admitted
    // and run its own dispatch-time check before the previous symbol's markExhausted() has
    // actually executed. A small real interval (backed by an actual setTimeout, which only fires
    // after the microtask queue — including that markExhausted() call — has fully drained)
    // guarantees each symbol's dispatch-time check observes every earlier symbol's fully-processed
    // exhaustion, exactly like production's real 1.1s spacing does. This is deliberately NOT
    // PROVIDER_RATE_LIMIT_DISABLED, which bypasses the pacer's queue entirely and would let every
    // symbol in the chunk race the network with no ordering guarantee whatsoever. The circuit
    // breaker IS disabled (independent from rate-limit pacing) since earlier tests in this file
    // already logged several failing "alpha-vantage"/"env" health rows against the same shared
    // temp DB, which would otherwise trip the breaker and short-circuit these calls before they
    // ever reach the mock.
    process.env.PROVIDER_RATE_LIMIT_DISABLED = "";
    process.env.PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS = "25";
    process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
    resetProviderRateLimiterState("alpha-vantage");

    try {
      let fetchCount = 0;
      vi.stubGlobal("fetch", async (url: string) => {
        fetchCount++;
        const key = new URL(url).searchParams.get("apikey") ?? "";
        // Both keys report the genuine daily-cap message the first time they're used, so key-1
        // exhausts on the 1st dispatch and key-2 exhausts on the 2nd — leaving the pool fully
        // exhausted before a 3rd symbol's dispatch-time check runs.
        return new Response(JSON.stringify({
          Note: `We have detected your API key as ${key} and our standard API rate limit is 25 requests per day...`
        }));
      });

      const provider = new AlphaVantageEnrichmentProvider([KEY_1, KEY_2], "env", undefined, pool);
      const res = await provider.enrich(["AAA", "BBB", "CCC"]); // 3 symbols, one chunk (CONCURRENCY=5)

      // Exactly 2 network calls: the 3rd symbol's dispatch-time allExhausted() re-check must have
      // short-circuited it (throwing before fetchWithRetry) instead of dispatching a 3rd
      // guaranteed-fail call.
      expect(fetchCount).toBe(2);
      expect(pool.allExhausted()).toBe(true);
      expect(res.AAA).toEqual({});
      expect(res.BBB).toEqual({});
      expect(res.CCC).toEqual({});
    } finally {
      delete process.env.PROVIDER_RATE_LIMIT_ALPHA_VANTAGE_MIN_INTERVAL_MS;
      delete process.env.PROVIDER_RATE_LIMIT_DISABLED;
      resetProviderRateLimiterState("alpha-vantage");
      vi.unstubAllGlobals();
    }
  });
});
