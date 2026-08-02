import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db so db module singleton state does not leak
// between test files (mirrors the pattern in test/data-providers.test.ts).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-quiver-provider-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

describe("QuiverQuant enrichment provider", () => {
  const originalKey = process.env.QUIVER_API_KEY;
  const originalNegTtl = process.env.QUIVER_NEGATIVE_CACHE_TTL_MS;
  const originalTtl = process.env.QUIVER_CACHE_TTL_MS;

  beforeEach(async () => {
    delete process.env.QUIVER_API_KEY;
    delete process.env.QUIVER_NEGATIVE_CACHE_TTL_MS;
    delete process.env.QUIVER_CACHE_TTL_MS;
    const { clearQuiverCache } = await import("../src/lib/quiver-provider");
    clearQuiverCache();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    if (originalKey) process.env.QUIVER_API_KEY = originalKey;
    else delete process.env.QUIVER_API_KEY;
    if (originalNegTtl) process.env.QUIVER_NEGATIVE_CACHE_TTL_MS = originalNegTtl;
    else delete process.env.QUIVER_NEGATIVE_CACHE_TTL_MS;
    if (originalTtl) process.env.QUIVER_CACHE_TTL_MS = originalTtl;
    else delete process.env.QUIVER_CACHE_TTL_MS;
    const { clearQuiverCache } = await import("../src/lib/quiver-provider");
    clearQuiverCache();
    vi.unstubAllGlobals();
  });

  // ── Registration gating ────────────────────────────────────────────────────

  it("is never registered when QUIVER_API_KEY is absent", async () => {
    delete process.env.QUIVER_API_KEY;
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = getEnrichmentProvider();
    expect(provider.name).not.toContain("quiverquant");
  });

  it("is registered when QUIVER_API_KEY is present", async () => {
    process.env.QUIVER_API_KEY = "test-quiver-key";
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = getEnrichmentProvider();
    expect(provider.name).toContain("quiverquant");
  });

  it("resolveQuiverApiKey trims whitespace and treats blank as unset", async () => {
    const { resolveQuiverApiKey } = await import("../src/lib/quiver-provider");
    process.env.QUIVER_API_KEY = "  abc123  ";
    expect(resolveQuiverApiKey()).toBe("abc123");
    process.env.QUIVER_API_KEY = "   ";
    expect(resolveQuiverApiKey()).toBeUndefined();
    delete process.env.QUIVER_API_KEY;
    expect(resolveQuiverApiKey()).toBeUndefined();
  });

  it("resolveQuiverApiKey falls back to QUIVERQUANT_API_TOKEN (owner's secret-store spelling)", async () => {
    const { resolveQuiverApiKey } = await import("../src/lib/quiver-provider");
    delete process.env.QUIVER_API_KEY;
    process.env.QUIVERQUANT_API_TOKEN = "token-spelling";
    expect(resolveQuiverApiKey()).toBe("token-spelling");
    // Primary spelling wins when both are set.
    process.env.QUIVER_API_KEY = "primary";
    expect(resolveQuiverApiKey()).toBe("primary");
    delete process.env.QUIVER_API_KEY;
    delete process.env.QUIVERQUANT_API_TOKEN;
  });

  // ── Row extraction / parsing (fixture payloads, both schema shapes seen from QuiverQuant) ──

  it("extractQuiverRows accepts a bare array and tolerates a wrapped envelope", async () => {
    const { extractQuiverRows } = await import("../src/lib/quiver-provider");
    expect(extractQuiverRows([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(extractQuiverRows({ results: [{ a: 1 }] })).toHaveLength(1);
    expect(extractQuiverRows({ data: [{ a: 1 }] })).toHaveLength(1);
    expect(extractQuiverRows(null)).toEqual([]);
    expect(extractQuiverRows({ nothing: true })).toEqual([]);
  });

  it("parseCongressTradesCount counts only rows within the trailing 180-day window", async () => {
    const { parseCongressTradesCount } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      // snake_case shape (as observed live) — within window
      { ticker: "AAPL", traded: "2026-06-24", filed: "2026-07-08" },
      // PascalCase shape (documented beta schema) — within window
      { Ticker: "AAPL", TransactionDate: "2026-05-01" },
      // stale — outside the 180-day window
      { ticker: "AAPL", traded: "2025-01-01", filed: "2025-01-15" },
      // unparseable date — excluded, never fabricated
      { ticker: "AAPL", traded: "not-a-date" }
    ];
    expect(parseCongressTradesCount(rows, now)).toBe(2);
    expect(parseCongressTradesCount([], now)).toBe(0);
  });

  it("parseInsiderTradesCount counts only rows within the trailing 90-day window", async () => {
    const { parseInsiderTradesCount } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      { ticker: "AAPL", date: "2026-06-16", file_date: "2026-06-17" }, // within
      { Ticker: "AAPL", TransactionDate: "2026-07-01" }, // within
      { ticker: "AAPL", date: "2026-01-01" } // stale
    ];
    expect(parseInsiderTradesCount(rows, now)).toBe(2);
  });

  it("parseGovContractsTotal sums $ obligated within the trailing 365-day window, tolerant of field casing", async () => {
    const { parseGovContractsTotal } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      { action_date: "2026-05-05 00:00:00", total_dollars_obligated: 58060.0 }, // within
      { ActionDate: "2026-01-10", TotalDollarsObligated: 1000 }, // within
      { action_date: "2024-01-01", total_dollars_obligated: 999999 } // stale — excluded
    ];
    expect(parseGovContractsTotal(rows, now)).toBe(59060);
  });

  it("parseLobbyingTotal sums $ within the trailing 365 days, falling back to Jan 1 of `year` when no date field is present", async () => {
    const { parseLobbyingTotal } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      { amount: 2480000, date: "2026-04-20", year: 2026 }, // within, has explicit date
      { Amount: 40000, year: 2026 }, // within, falls back to 2026-01-01
      { amount: 110000, year: 2023 } // stale via year fallback — excluded
    ];
    expect(parseLobbyingTotal(rows, now)).toBe(2520000);
  });

  it("parsePatentsCount counts only patents published within the trailing 180-day window", async () => {
    const { parsePatentsCount } = await import("../src/lib/quiver-provider");
    const now = Date.parse("2026-07-15T00:00:00Z");
    const rows = [
      { pub_date: "2026-07-07", title: "attachment system" },
      { PubDate: "2026-06-01", title: "retinal tracking" },
      { pub_date: "2025-01-01", title: "stale patent" }
    ];
    expect(parsePatentsCount(rows, now)).toBe(2);
  });

  // ── Provider enrich() behavior: fetch wiring, caching, negative TTL, fail-open ──

  function stubFiveEndpoints(bySymbol: Record<string, unknown[] | Error>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const match = /historical\/[a-z]+\/([A-Z]+)$/.exec(url);
        const symbol = match?.[1] ?? "";
        const value = bySymbol[symbol];
        if (value instanceof Error) throw value;
        return new Response(JSON.stringify(value ?? []), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
  }

  it("enrich() produces all five carrier fields from a fully successful fetch", async () => {
    const now = Date.parse("2026-07-15T00:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    stubFiveEndpoints({
      AAPL: [{ ticker: "AAPL", traded: "2026-07-01", total_dollars_obligated: 5000, amount: 5000, pub_date: "2026-07-01", date: "2026-07-01" }]
    });
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const provider = new QuiverEnrichmentProvider("test-key");
    const out = await provider.enrich(["AAPL"]);
    expect(out.AAPL.congressTradesQuiver).toBe(1);
    expect(out.AAPL.insiderTradesQuiver).toBe(1);
    expect(out.AAPL.govContractsQuiver).toBe(5000);
    expect(out.AAPL.lobbyingQuiver).toBe(5000);
    expect(out.AAPL.patentsQuiver).toBe(1);
    vi.useRealTimers();
  });

  it("caches a fully successful result and does not refetch within the TTL", async () => {
    stubFiveEndpoints({ MSFT: [{ ticker: "MSFT", traded: "2026-07-01", date: "2026-07-01" }] });
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const provider = new QuiverEnrichmentProvider("test-key");
    await provider.enrich(["MSFT"]);
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBe(5); // one call per dataset
    await provider.enrich(["MSFT"]);
    const callsAfterSecond = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst); // served entirely from cache
  });

  it("fails open on a partial failure: surfaces the fields that succeeded and omits the failed one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("historical/congresstrading")) throw new Error("network down");
        return new Response(JSON.stringify([{ ticker: "TSLA", date: "2026-07-01", traded: "2026-07-01", total_dollars_obligated: 10, amount: 10, pub_date: "2026-07-01" }]), { status: 200 });
      })
    );
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const provider = new QuiverEnrichmentProvider("test-key");
    const out = await provider.enrich(["TSLA"]);
    expect(out.TSLA.congressTradesQuiver).toBeUndefined();
    expect(out.TSLA.insiderTradesQuiver).toBe(1);
    expect(out.TSLA.govContractsQuiver).toBe(10);
    expect(out.TSLA.lobbyingQuiver).toBe(10);
    expect(out.TSLA.patentsQuiver).toBe(1);
  });

  it("caches a partial-failure result under the shorter negative TTL and retries sooner than the positive floor", async () => {
    process.env.QUIVER_NEGATIVE_CACHE_TTL_MS = "1"; // effectively immediate re-eligibility
    let congressCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("historical/congresstrading")) {
          congressCalls++;
          throw new Error("network down");
        }
        return new Response(JSON.stringify([]), { status: 200 });
      })
    );
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const provider = new QuiverEnrichmentProvider("test-key");
    await provider.enrich(["NFLX"]);
    expect(congressCalls).toBe(1);
    // Wait past the 1ms negative TTL, then enrich again — the negative-cached partial result
    // must be retried (not pinned to the 24h positive floor) rather than silently staying stale.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await provider.enrich(["NFLX"]);
    expect(congressCalls).toBe(2);
  });

  it("never throws out of enrich() even when every sub-fetch fails (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("total outage"); }));
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const provider = new QuiverEnrichmentProvider("test-key");
    const out = await provider.enrich(["GME"]);
    expect(out.GME).toEqual({});
  });

  // ── Cascade integration: a produced value actually lands in SymbolEnrichment via takeScalar ──

  it("a Quiver-produced value flows through CascadingEnrichmentProvider's takeScalar into the merged SymbolEnrichment with correct source attribution", async () => {
    stubFiveEndpoints({
      AMZN: [{ ticker: "AMZN", traded: "2026-07-01", date: "2026-07-01", total_dollars_obligated: 12345, amount: 12345, pub_date: "2026-07-01" }]
    });
    const { QuiverEnrichmentProvider } = await import("../src/lib/quiver-provider");
    const { CascadingEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = new QuiverEnrichmentProvider("test-key");
    const cascade = new CascadingEnrichmentProvider([provider]);
    const merged = await cascade.enrich(["AMZN"]);
    expect(merged.AMZN.congressTradesQuiver).toBe(1);
    expect(merged.AMZN.govContractsQuiver).toBe(12345);
    expect(merged.AMZN.sources?.congressTradesQuiver).toBe("quiverquant");
    expect(merged.AMZN.sources?.govContractsQuiver).toBe("quiverquant");
    expect(cascade.activeSources).toContain("quiverquant");
  });
});
