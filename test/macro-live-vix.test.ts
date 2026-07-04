/**
 * macro-live-vix.test.ts
 *
 * Covers the live ^VIX overlay (composite review D/high/S: "Split VIX/vol gauges off the 24h
 * macro cache"). Before this, the volatility panic brake and the regime-flip detector both read
 * `fetchMacroData`, which is cached 24h — on a crash day the brake/flip detector could be reading
 * a VIX reading up to a day stale. `fetchLiveVix`/`fetchMacroDataWithLiveVix` add a SEPARATE,
 * short-TTL (10 min) cache entry sourced from the same key-free Yahoo ^VIX chart endpoint the
 * no-FRED fallback already uses, so callers get a materially fresher VIX without a new upstream
 * dependency.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-macro-live-vix-${randomUUID()}.db`)}`;
});

/** Stub global fetch: FRED calls (api.stlouisfed.org) return a constant reading; the Yahoo ^VIX
 *  chart call (query1.finance.yahoo.com) returns the given VIX close (or fails when null). */
function stubFetch(opts: { fredValue?: string; yahooVix?: number | null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("query1.finance.yahoo.com")) {
        if (opts.yahooVix === null || opts.yahooVix === undefined) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        return {
          ok: true,
          json: async () => ({
            chart: { result: [{ indicators: { quote: [{ close: [opts.yahooVix] }] } }] }
          })
        };
      }
      if (url.includes("api.stlouisfed.org")) {
        return { ok: true, json: async () => ({ observations: [{ value: opts.fredValue ?? "4.50" }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    })
  );
}

describe("fetchLiveVix", () => {
  beforeEach(async () => {
    const { clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a live VIX reading with a real asOf on success", async () => {
    stubFetch({ yahooVix: 22.5 });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const result = await fetchLiveVix();
    expect(result.vix).toBe(22.5);
    expect(result.asOf).not.toBeNull();
  });

  it("returns vix:null and asOf:null on fetch failure (never fabricates a reading)", async () => {
    stubFetch({ yahooVix: null });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const result = await fetchLiveVix();
    expect(result.vix).toBeNull();
    expect(result.asOf).toBeNull();
  });

  it("caches the live reading for repeat calls within the short TTL (single upstream call)", async () => {
    stubFetch({ yahooVix: 18.0 });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const now = Date.now();
    const first = await fetchLiveVix(now);
    const second = await fetchLiveVix(now + 60_000); // 1 min later — still inside the 10 min TTL
    expect(first.vix).toBe(18.0);
    expect(second.vix).toBe(18.0);
    expect(second.asOf).toBe(first.asOf); // served from cache, same stamp
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches after the short TTL expires", async () => {
    stubFetch({ yahooVix: 18.0 });
    const { fetchLiveVix } = await import("../src/lib/macro");
    const now = Date.now();
    await fetchLiveVix(now);
    await fetchLiveVix(now + 11 * 60_000); // past the 10 min TTL
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchMacroDataWithLiveVix", () => {
  beforeEach(async () => {
    delete process.env.FRED_API_KEY;
    const { clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FRED_API_KEY;
  });

  it("overlays the live VIX onto the cached macro snapshot, stamping vixAsOf", async () => {
    process.env.FRED_API_KEY = "env-key-live-vix-test";
    stubFetch({ fredValue: "5.00", yahooVix: 31.25 });

    const { fetchMacroDataWithLiveVix, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    const result = await fetchMacroDataWithLiveVix("user-live-vix");

    expect(result.vix).toBe("31.25");
    expect(result.vixAsOf).toBeDefined();
    // Everything else still comes from the (mocked) FRED suite.
    expect(result.fedFundsRate).toBe("5.00%");
  });

  it("falls back to the cached macro's own VIX when the live fetch fails", async () => {
    process.env.FRED_API_KEY = "env-key-live-vix-fallback";
    stubFetch({ fredValue: "5.00", yahooVix: null });

    const { fetchMacroDataWithLiveVix, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    const result = await fetchMacroDataWithLiveVix("user-live-vix-2");

    // Live fetch failed -> falls back to whatever fetchMacroData resolved (the FRED-sourced VIX).
    expect(result.vix).toBe("5.00");
    expect(result.vixAsOf).toBeUndefined();
  });

  it("promotes an 'unavailable' macro snapshot to live when the VIX overlay succeeds", async () => {
    // No FRED key at all -> fetchMacroData would normally fall back to fetchVixOnlyFallback,
    // which ALSO calls fetchVixFromYahoo. Simulate the (rarer) case where the light-macro path's
    // own VIX attempt failed (asOf stays "unavailable") but a subsequent live-VIX call succeeds.
    delete process.env.FRED_API_KEY;
    stubFetch({ yahooVix: null }); // first pass: the light-macro fallback's VIX attempt fails too

    const { fetchMacroData, clearMacroCacheForTests } = await import("../src/lib/macro");
    clearMacroCacheForTests();
    const unavailable = await fetchMacroData("user-live-vix-3");
    expect(unavailable.asOf).toBe("unavailable");

    // Now the live path succeeds on a later call.
    stubFetch({ yahooVix: 27.0 });
    const { fetchMacroDataWithLiveVix } = await import("../src/lib/macro");
    const overlaid = await fetchMacroDataWithLiveVix("user-live-vix-3");
    expect(overlaid.vix).toBe("27.00");
    expect(overlaid.asOf).not.toBe("unavailable");
    expect(overlaid.vixAsOf).toBeDefined();
  });
});
