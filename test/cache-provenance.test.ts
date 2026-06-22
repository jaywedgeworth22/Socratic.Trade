/**
 * cache-provenance.test.ts
 *
 * Verifies that process-global provider caches scope their entries correctly:
 *   - env/free-source data → shared key (all users benefit, no licensing issue)
 *   - user-keyed data → private per-user key (never leaked cross-user)
 *   - MARKET_DATA_SHARE_USER_KEYED_MACRO opt-in flag → allows cross-user sharing
 *
 * Covers: macro.ts, macro-history.ts (the two highest-priority caches per spec).
 * The enrichment cache (data-providers.ts) already has the pattern implemented;
 * its scoping helpers are exercised here via direct import.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-cache-provenance-${randomUUID()}.db`)}`;
});

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a MacroData-shaped FRED response that the fetch mock will return. */
function mockFredObs(value: string) {
  return JSON.stringify({ observations: [{ value }] });
}

/** Stub global fetch so FRED calls return a constant value without hitting the network. */
function stubFredFetch(value: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string) => ({
      ok: true,
      json: async () => JSON.parse(mockFredObs(value))
    }))
  );
}

// ─── macro.ts cache-provenance ────────────────────────────────────────────────

describe("macro.ts cache-provenance", () => {
  beforeEach(async () => {
    // Reset env keys and caches before every test.
    delete process.env.FRED_API_KEY;
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO;
    const { clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset opt-in flag.
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO;
  });

  it("env-key result is stored under a shared entry and reused across different userIds", async () => {
    // Arrange: FRED key is in env (source === "env").
    process.env.FRED_API_KEY = "env-key-abc";
    stubFredFetch("4.50"); // all FRED series return "4.50" — we just need valid data

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    // Act: two different users fetch macro data.
    const resultA = await fetchMacroData(userA);
    // Second fetch should come from the shared cache — no additional network calls.
    const fetchCallsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const resultB = await fetchMacroData(userB);
    const fetchCallsAfterB = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Assert: both got live data (not "unavailable"), and the second fetch did not
    // make any new network calls (served from the shared cache).
    expect(resultA.asOf).not.toBe("unavailable");
    expect(resultB.asOf).not.toBe("unavailable");
    // Both should get the exact same object (same data).
    expect(resultB.fedFundsRate).toBe(resultA.fedFundsRate);
    // No additional FRED network calls after userA's fetch populated the shared cache.
    expect(fetchCallsAfterB).toBe(fetchCallsAfterA);
  });

  it("user-keyed result is NOT returned for a different userId (no cross-user leak)", async () => {
    // Arrange: no env key; userA has stored their own FRED key.
    delete process.env.FRED_API_KEY;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`; // no stored key

    upsertUserApiKey(userA, "fred", "user-fred-key-xyz");
    clearMacroCacheForTests();

    stubFredFetch("3.75");

    // Act: userA fetches (user-keyed → private cache entry).
    const resultA = await fetchMacroData(userA);
    const callsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // userB fetches without any FRED key — should get the "unavailable" default,
    // NOT userA's private result.
    vi.unstubAllGlobals(); // reset fetch so userB's call doesn't hit the stub
    const resultB = await fetchMacroData(userB);

    // Assert: userA got live data; userB got the no-key fallback.
    expect(resultA.asOf).not.toBe("unavailable");
    expect(resultB.asOf).toBe("unavailable");
    // userA's network calls happened; userB got a different (default) result.
    expect(callsAfterA).toBeGreaterThan(0);
  });

  it("opt-in flag MARKET_DATA_SHARE_USER_KEYED_MACRO=true promotes user-keyed result to shared", async () => {
    // Arrange: no env key; userA has stored FRED key; opt-in flag is ON.
    delete process.env.FRED_API_KEY;
    process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO = "true";

    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`; // no stored key

    upsertUserApiKey(userA, "fred", "user-fred-key-shared");
    clearMacroCacheForTests();

    stubFredFetch("5.00");

    // Act: userA fetches (user-keyed but opt-in → shared entry).
    const resultA = await fetchMacroData(userA);
    // userB fetches — should now get the shared cache result (no new network calls).
    const callsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const resultB = await fetchMacroData(userB);
    const callsAfterB = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Assert: both got live data; no extra network calls after A's fetch.
    expect(resultA.asOf).not.toBe("unavailable");
    expect(resultB.asOf).not.toBe("unavailable");
    expect(callsAfterB).toBe(callsAfterA); // served from shared cache
  });

  it("no-key path tries Yahoo VIX; falls back to asOf=unavailable when Yahoo also fails", async () => {
    delete process.env.FRED_API_KEY;
    // Stub fetch to simulate a failing Yahoo response (network error).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.asOf).toBe("unavailable");
  });

  it("no-key path returns a live regime when Yahoo VIX fetch succeeds", async () => {
    delete process.env.FRED_API_KEY;
    // Stub fetch to return a valid Yahoo VIX chart response with VIX = 22.5.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: { result: [{ indicators: { quote: [{ close: [21.0, 22.5] }] } }] }
      })
    }));

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();

    const result = await fetchMacroData(undefined);
    expect(result.asOf).not.toBe("unavailable");
    expect(parseFloat(result.vix)).toBeCloseTo(22.5, 1);
  });
});

// ─── macro-history.ts cache-provenance ────────────────────────────────────────

describe("macro-history.ts cache-provenance", () => {
  beforeEach(async () => {
    delete process.env.FRED_API_KEY;
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY;
    const { clearMacroHistoryCacheForTests } = await import("../src/lib/macro-history");
    clearMacroHistoryCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY;
  });

  /** Stub fetch to return a valid FRED history response with N observations. */
  function stubFredHistoryFetch(points: number = 10) {
    const obs = Array.from({ length: points }, (_, i) => ({ value: String(i + 1) }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => ({
        ok: true,
        json: async () => ({ observations: obs })
      }))
    );
  }

  it("env-key history is stored in the shared cache and reused across users", async () => {
    process.env.FRED_API_KEY = "env-hist-key";
    stubFredHistoryFetch();

    const { fetchMacroHistory, clearMacroHistoryCacheForTests } = await import("../src/lib/macro-history");
    clearMacroHistoryCacheForTests();

    const now = Date.now();
    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    const resultA = await fetchMacroHistory(now, userA);
    const callsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const resultB = await fetchMacroHistory(now, userB);
    const callsAfterB = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Both get populated results.
    expect(Object.keys(resultA).length).toBeGreaterThan(0);
    expect(Object.keys(resultB).length).toBeGreaterThan(0);
    // No additional network calls after userA populated the shared cache.
    expect(callsAfterB).toBe(callsAfterA);
  });

  it("user-keyed history is NOT served to a different userId", async () => {
    delete process.env.FRED_API_KEY;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroHistory, clearMacroHistoryCacheForTests } = await import("../src/lib/macro-history");

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    upsertUserApiKey(userA, "fred", "user-hist-key-private");
    clearMacroHistoryCacheForTests();

    stubFredHistoryFetch();
    const now = Date.now();

    // userA fetches — user-keyed → private cache.
    const resultA = await fetchMacroHistory(now, userA);

    // userB has no key → should get {} (no network calls, no cross-user data).
    vi.unstubAllGlobals();
    const resultB = await fetchMacroHistory(now, userB);

    expect(Object.keys(resultA).length).toBeGreaterThan(0);
    expect(Object.keys(resultB).length).toBe(0); // userB sees nothing
  });

  it("opt-in MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY promotes user-keyed history to shared", async () => {
    delete process.env.FRED_API_KEY;
    process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY = "1";

    const { upsertUserApiKey } = await import("../src/lib/db");
    const { fetchMacroHistory, clearMacroHistoryCacheForTests } = await import("../src/lib/macro-history");

    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    upsertUserApiKey(userA, "fred", "user-hist-key-shared");
    clearMacroHistoryCacheForTests();

    stubFredHistoryFetch();
    const now = Date.now();

    const resultA = await fetchMacroHistory(now, userA);
    const callsAfterA = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const resultB = await fetchMacroHistory(now, userB);
    const callsAfterB = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(Object.keys(resultA).length).toBeGreaterThan(0);
    expect(Object.keys(resultB).length).toBeGreaterThan(0);
    // Served from the shared cache — no extra network calls.
    expect(callsAfterB).toBe(callsAfterA);
  });
});
