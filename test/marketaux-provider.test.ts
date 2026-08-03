import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Each test file gets its own isolated SQLite db so db module singleton state does not leak
// between test files (mirrors the pattern in test/quiver-provider.test.ts).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-marketaux-provider-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

// Realistic response shape, restructured from the live-verified marketaux.com/documentation
// example (fetched 2026-08-02) — field names, nesting, and value RANGES are real; the specific
// copyrighted example text (titles/snippets/URLs) is not reproduced, replaced with synthetic
// equivalents that exercise the same fields.
function fixtureArticle(overrides: {
  title: string;
  symbol: string;
  sentimentScore: number;
}) {
  return {
    uuid: randomUUID(),
    title: overrides.title,
    description: "",
    keywords: "",
    snippet: "synthetic snippet text for test fixture",
    url: "https://example.com/article",
    image_url: "https://example.com/image.jpg",
    language: "en",
    published_at: "2026-08-01T12:00:00.000000Z",
    source: "example.com",
    relevance_score: null,
    entities: [
      {
        symbol: overrides.symbol,
        name: `${overrides.symbol} Inc.`,
        exchange: null,
        exchange_long: null,
        country: "us",
        type: "equity",
        industry: "Technology",
        match_score: 12.3,
        sentiment_score: overrides.sentimentScore,
        highlights: [
          { highlight: "synthetic highlight", sentiment: overrides.sentimentScore, highlighted_in: "title" }
        ]
      }
    ],
    similar: []
  };
}

describe("Marketaux enrichment provider", () => {
  const originalKey = process.env.MARKETAUX_API_KEY;
  const originalTtl = process.env.MARKETAUX_CACHE_TTL_MS;
  const originalNegTtl = process.env.MARKETAUX_NEGATIVE_CACHE_TTL_MS;
  const originalBudget = process.env.MARKETAUX_DAILY_REQUEST_BUDGET;
  const originalGroupSize = process.env.MARKETAUX_SYMBOLS_PER_REQUEST;

  beforeEach(async () => {
    delete process.env.MARKETAUX_API_KEY;
    delete process.env.MARKETAUX_CACHE_TTL_MS;
    delete process.env.MARKETAUX_NEGATIVE_CACHE_TTL_MS;
    delete process.env.MARKETAUX_DAILY_REQUEST_BUDGET;
    delete process.env.MARKETAUX_SYMBOLS_PER_REQUEST;
    const { clearMarketauxCache, resetMarketauxDailyBudget } = await import("../src/lib/marketaux-provider");
    clearMarketauxCache();
    resetMarketauxDailyBudget();
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    if (originalKey) process.env.MARKETAUX_API_KEY = originalKey;
    else delete process.env.MARKETAUX_API_KEY;
    if (originalTtl) process.env.MARKETAUX_CACHE_TTL_MS = originalTtl;
    else delete process.env.MARKETAUX_CACHE_TTL_MS;
    if (originalNegTtl) process.env.MARKETAUX_NEGATIVE_CACHE_TTL_MS = originalNegTtl;
    else delete process.env.MARKETAUX_NEGATIVE_CACHE_TTL_MS;
    if (originalBudget) process.env.MARKETAUX_DAILY_REQUEST_BUDGET = originalBudget;
    else delete process.env.MARKETAUX_DAILY_REQUEST_BUDGET;
    if (originalGroupSize) process.env.MARKETAUX_SYMBOLS_PER_REQUEST = originalGroupSize;
    else delete process.env.MARKETAUX_SYMBOLS_PER_REQUEST;
    const { clearMarketauxCache, resetMarketauxDailyBudget } = await import("../src/lib/marketaux-provider");
    clearMarketauxCache();
    resetMarketauxDailyBudget();
    vi.unstubAllGlobals();
  });

  // ── Key resolution ──────────────────────────────────────────────────────────

  it("resolveMarketauxApiKey trims whitespace and treats blank as unset", async () => {
    const { resolveMarketauxApiKey } = await import("../src/lib/marketaux-provider");
    process.env.MARKETAUX_API_KEY = "  abc123  ";
    expect(resolveMarketauxApiKey()).toBe("abc123");
    process.env.MARKETAUX_API_KEY = "   ";
    expect(resolveMarketauxApiKey()).toBeUndefined();
    delete process.env.MARKETAUX_API_KEY;
    expect(resolveMarketauxApiKey()).toBeUndefined();
  });

  // ── Parsing helpers (fixture payloads matching the live-verified response shape) ────────────

  it("extractMarketauxArticles accepts the documented { data: [...] } envelope and tolerates malformed payloads", async () => {
    const { extractMarketauxArticles } = await import("../src/lib/marketaux-provider");
    expect(extractMarketauxArticles({ data: [{ title: "a" }, { title: "b" }] })).toHaveLength(2);
    // Malformed/empty variants must all produce [] — never throw, never fabricate.
    expect(extractMarketauxArticles(null)).toEqual([]);
    expect(extractMarketauxArticles(undefined)).toEqual([]);
    expect(extractMarketauxArticles("not json")).toEqual([]);
    expect(extractMarketauxArticles({})).toEqual([]);
    expect(extractMarketauxArticles({ data: null })).toEqual([]);
    expect(extractMarketauxArticles({ data: "oops" })).toEqual([]);
    expect(extractMarketauxArticles({ data: [null, 42, "x", { title: "keep me" }] })).toEqual([{ title: "keep me" }]);
    // The documented API error envelope has no `data` key at all.
    expect(extractMarketauxArticles({ error: { code: "invalid_api_token", message: "An invalid API token was supplied." } })).toEqual([]);
  });

  it("mapMarketauxSentiment maps the documented -1..+1 (0=neutral) range onto 0-100 (50=neutral), clamped", async () => {
    const { mapMarketauxSentiment } = await import("../src/lib/marketaux-provider");
    expect(mapMarketauxSentiment(0)).toBe(50);
    expect(mapMarketauxSentiment(1)).toBe(100);
    expect(mapMarketauxSentiment(-1)).toBe(0);
    // Live-verified doc example value.
    expect(mapMarketauxSentiment(0.7783)).toBe(89);
    // Out-of-documented-range inputs (defensive) still clamp instead of exploding.
    expect(mapMarketauxSentiment(5)).toBe(100);
    expect(mapMarketauxSentiment(-5)).toBe(0);
  });

  it("aggregateMarketauxBySymbol groups headlines/sentiment per symbol and averages multi-article sentiment", async () => {
    const { aggregateMarketauxBySymbol } = await import("../src/lib/marketaux-provider");
    const articles = [
      fixtureArticle({ title: "Tesla surges on delivery beat", symbol: "TSLA", sentimentScore: 0.7783 }),
      fixtureArticle({ title: "Tesla faces new regulatory scrutiny", symbol: "TSLA", sentimentScore: -0.2 }),
      fixtureArticle({ title: "Amazon expands logistics network", symbol: "AMZN", sentimentScore: 0 })
    ];
    const out = aggregateMarketauxBySymbol(articles, ["TSLA", "AMZN", "MSFT"]);
    expect(out.TSLA.headlines).toEqual(["Tesla surges on delivery beat", "Tesla faces new regulatory scrutiny"]);
    // (0.7783 + -0.2) / 2 = 0.28915 -> 50 + 0.28915*50 = 64.4575 -> round 64
    expect(out.TSLA.sentiment).toBe(64);
    expect(out.AMZN.headlines).toEqual(["Amazon expands logistics network"]);
    expect(out.AMZN.sentiment).toBe(50);
    // A requested symbol with no matching entity anywhere gets {} — never fabricated.
    expect(out.MSFT).toEqual({});
  });

  it("aggregateMarketauxBySymbol ignores entities for symbols that were not requested and malformed entity rows", async () => {
    const { aggregateMarketauxBySymbol } = await import("../src/lib/marketaux-provider");
    const articles = [
      {
        title: "Unrelated ticker mentioned",
        entities: [
          { symbol: "NFLX", sentiment_score: 0.9 }, // not requested
          null,
          "not an object",
          { symbol: 12345, sentiment_score: 0.5 }, // non-string symbol
          { symbol: "AAPL", sentiment_score: "not-a-number" } // unparseable score, headline still counts
        ]
      }
    ];
    const out = aggregateMarketauxBySymbol(articles, ["AAPL"]);
    expect(out.AAPL.headlines).toEqual(["Unrelated ticker mentioned"]);
    expect(out.AAPL.sentiment).toBeUndefined();
  });

  it("aggregateMarketauxBySymbol caps headlines per symbol and de-duplicates repeated titles", async () => {
    const { aggregateMarketauxBySymbol } = await import("../src/lib/marketaux-provider");
    const articles = Array.from({ length: 8 }, (_, i) =>
      fixtureArticle({ title: `Headline number ${i % 3}`, symbol: "AAPL", sentimentScore: 0.1 })
    );
    const out = aggregateMarketauxBySymbol(articles, ["AAPL"]);
    // Only 3 distinct titles exist across the 8 articles, well under the 5-per-symbol cap.
    expect(out.AAPL.headlines).toEqual(["Headline number 0", "Headline number 1", "Headline number 2"]);
  });

  // ── Provider enrich() behavior: fetch wiring, batching, caching, fail-open ──────────────────

  function stubNewsEndpoint(bySymbolGroup: (symbols: string[]) => unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const match = /[?&]symbols=([^&]+)/.exec(url);
        const symbols = match ? decodeURIComponent(match[1]).split(",") : [];
        const payload = bySymbolGroup(symbols);
        if (payload instanceof Error) throw payload;
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
  }

  it("enrich() batches symbols into one request per group and fills headlines + sentiment", async () => {
    process.env.MARKETAUX_SYMBOLS_PER_REQUEST = "2";
    stubNewsEndpoint((symbols) => ({
      meta: { found: 1, returned: 1, limit: 3, page: 1 },
      data: symbols.includes("AAPL") ? [fixtureArticle({ title: "Apple news", symbol: "AAPL", sentimentScore: 0.5 })] : []
    }));
    const { MarketauxEnrichmentProvider } = await import("../src/lib/marketaux-provider");
    const provider = new MarketauxEnrichmentProvider("test-key");
    const out = await provider.enrich(["AAPL", "MSFT"]);
    expect(out.AAPL.headlines).toEqual(["Apple news"]);
    expect(out.AAPL.sentiment).toBe(75);
    expect(out.MSFT).toEqual({});
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // one batch call for the pair
  });

  it("caches a successful fetch and does not refetch within the TTL", async () => {
    stubNewsEndpoint(() => ({ data: [fixtureArticle({ title: "Cached headline", symbol: "MSFT", sentimentScore: 0 })] }));
    const { MarketauxEnrichmentProvider } = await import("../src/lib/marketaux-provider");
    const provider = new MarketauxEnrichmentProvider("test-key");
    await provider.enrich(["MSFT"]);
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBe(1);
    await provider.enrich(["MSFT"]);
    const callsAfterSecond = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterSecond).toBe(callsAfterFirst); // served entirely from cache
  });

  it("never throws out of enrich() on a total fetch failure (fail-open) and negative-caches the miss", async () => {
    process.env.MARKETAUX_NEGATIVE_CACHE_TTL_MS = "60000";
    stubNewsEndpoint(() => new Error("network down"));
    const { MarketauxEnrichmentProvider } = await import("../src/lib/marketaux-provider");
    const provider = new MarketauxEnrichmentProvider("test-key");
    const out = await provider.enrich(["GME"]);
    expect(out.GME).toEqual({});
    const callsAfterFirst = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterFirst).toBe(1);
    // Still within the negative TTL — must not immediately re-fire the request.
    await provider.enrich(["GME"]);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });

  it("treats a non-ok HTTP response (e.g. the documented usage_limit_reached 402) as a caught failure, not a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "usage_limit_reached", message: "Usage limit reached." } }), { status: 402 }))
    );
    const { MarketauxEnrichmentProvider } = await import("../src/lib/marketaux-provider");
    const provider = new MarketauxEnrichmentProvider("test-key");
    const out = await provider.enrich(["IBM"]);
    expect(out.IBM).toEqual({});
  });

  it("treats a malformed/empty response body as no data, never fabricated fields", async () => {
    stubNewsEndpoint(() => ({}));
    const { MarketauxEnrichmentProvider } = await import("../src/lib/marketaux-provider");
    const provider = new MarketauxEnrichmentProvider("test-key");
    const out = await provider.enrich(["ORCL"]);
    expect(out.ORCL).toEqual({});
  });

  it("stops issuing requests once the daily budget is exhausted, leaving remaining symbols unfilled without throwing", async () => {
    process.env.MARKETAUX_DAILY_REQUEST_BUDGET = "1";
    process.env.MARKETAUX_SYMBOLS_PER_REQUEST = "1"; // force 2 distinct groups for 2 symbols
    stubNewsEndpoint((symbols) => ({ data: [fixtureArticle({ title: "news", symbol: symbols[0], sentimentScore: 0.2 })] }));
    const { MarketauxEnrichmentProvider } = await import("../src/lib/marketaux-provider");
    const provider = new MarketauxEnrichmentProvider("test-key");
    const out = await provider.enrich(["AAPL", "MSFT"]);
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBe(1); // budget of 1 allows exactly one of the two groups through
    const filled = [out.AAPL, out.MSFT].filter((d) => d.headlines !== undefined).length;
    expect(filled).toBe(1);
    const empty = [out.AAPL, out.MSFT].filter((d) => Object.keys(d).length === 0).length;
    expect(empty).toBe(1);
  });

  // ── Cascade integration: a produced value actually flows through takeScalar with attribution ──

  it("a Marketaux-produced sentiment value flows through CascadingEnrichmentProvider with correct source attribution; headlines is not a sourced field", async () => {
    stubNewsEndpoint(() => ({ data: [fixtureArticle({ title: "Amazon rallies on cloud growth", symbol: "AMZN", sentimentScore: 0.6 })] }));
    const { MarketauxEnrichmentProvider } = await import("../src/lib/marketaux-provider");
    const { CascadingEnrichmentProvider } = await import("../src/lib/data-providers");
    const provider = new MarketauxEnrichmentProvider("test-key");
    const cascade = new CascadingEnrichmentProvider([provider]);
    const merged = await cascade.enrich(["AMZN"]);
    expect(merged.AMZN.sentiment).toBe(80);
    expect(merged.AMZN.headlines).toEqual(["Amazon rallies on cloud growth"]);
    expect(merged.AMZN.sources?.sentiment).toBe("marketaux");
    expect(cascade.activeSources).toContain("marketaux");
  });
});
