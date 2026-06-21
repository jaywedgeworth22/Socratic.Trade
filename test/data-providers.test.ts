import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlpacaSnapshotEnrichmentProvider,
  alpacaDataFeed,
  analystScoreFromCounts,
  analystScoreFromMean,
  getEnrichmentProvider,
  isTransientError,
  labelFromAnalystScore,
  mockEnrichmentProvider,
  noopProvider,
  parseAlpacaSnapshot,
  parseWebullUnofficialQuote,
  scoreHeadlines
} from "../src/lib/data-providers";

// Each test file gets its own isolated SQLite db so db module singleton state
// (user API keys, consent records) does not leak between test files.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-data-providers-${randomUUID()}.db`)}`;
});

describe("market enrichment provider", () => {
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalFmpKey = process.env.FMP_API_KEY;
  const originalAlphaVantageKey = process.env.ALPHAVANTAGE_API_KEY;
  const originalWebullEnabled = process.env.WEBULL_UNOFFICIAL_ENABLED;
  const originalFintechKey = process.env.FINTECH_STUDIOS_API_KEY;
  const originalFintechBase = process.env.FINTECH_STUDIOS_BASE_URL;

  beforeEach(() => {
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.WEBULL_UNOFFICIAL_ENABLED;
    delete process.env.FINTECH_STUDIOS_API_KEY;
    delete process.env.FINTECH_STUDIOS_BASE_URL;
  });

  afterEach(() => {
    if (originalFinnhubKey) process.env.FINNHUB_API_KEY = originalFinnhubKey;
    else delete process.env.FINNHUB_API_KEY;
    if (originalFmpKey) process.env.FMP_API_KEY = originalFmpKey;
    else delete process.env.FMP_API_KEY;
    if (originalAlphaVantageKey) process.env.ALPHAVANTAGE_API_KEY = originalAlphaVantageKey;
    else delete process.env.ALPHAVANTAGE_API_KEY;
    if (originalWebullEnabled) process.env.WEBULL_UNOFFICIAL_ENABLED = originalWebullEnabled;
    else delete process.env.WEBULL_UNOFFICIAL_ENABLED;
    if (originalFintechKey) process.env.FINTECH_STUDIOS_API_KEY = originalFintechKey;
    else delete process.env.FINTECH_STUDIOS_API_KEY;
    if (originalFintechBase) process.env.FINTECH_STUDIOS_BASE_URL = originalFintechBase;
    else delete process.env.FINTECH_STUDIOS_BASE_URL;
  });

  it("uses Yahoo Finance provider when no API key is configured", async () => {
    const provider = getEnrichmentProvider();
    // Yahoo Finance is always the final real tier — no API key required.
    expect(provider.configured).toBe(true);
    expect(provider.name).toBe("yahoo-finance");
  });

  it("keeps the unofficial Webull quote bridge disabled by default", async () => {
    const provider = getEnrichmentProvider();
    expect(provider.name).not.toContain("webull-unofficial");
  });

  it("adds the unofficial Webull quote bridge only when explicitly enabled", async () => {
    process.env.WEBULL_UNOFFICIAL_ENABLED = "on";
    const provider = getEnrichmentProvider();
    expect(provider.name).toContain("webull-unofficial");
    expect(provider.name).toContain("yahoo-finance");
  });

  it("parses unofficial Webull quote payloads as market data only", () => {
    const parsed = parseWebullUnofficialQuote({
      close: "205.50",
      bid: "205.40",
      ask: "205.60",
      preClose: "203.20",
      volume: "1500000",
      peTtm: "36.05",
      epsTtm: "8.27",
      pb: "41.05",
      yield: "0.0036",
      fiftyTwoWkHigh: "220.10",
      fiftyTwoWkLow: "145.25",
      name: "Apple Inc."
    });

    expect(parsed).toMatchObject({
      price: 205.5,
      bid: 205.4,
      ask: 205.6,
      intradayChangePct: 1.13,
      volume: 1500000,
      peRatio: 36.05,
      eps: 8.27,
      pbRatio: 41.05,
      dividendYield: 0.36,
      fiftyTwoWeekHigh: 220.1,
      fiftyTwoWeekLow: 145.25,
      companyName: "Apple Inc."
    });
    expect(parsed).not.toHaveProperty("brokerOrderId");
  });

  it("mock provider returns fallback data for unknown tickers", async () => {
    const enriched = await mockEnrichmentProvider.enrich(["XYZUNK"]);
    expect(enriched.XYZUNK).toBeDefined();
    expect(enriched.XYZUNK?.sector).toBeTruthy();
    expect(enriched.XYZUNK?.peRatio).toBeGreaterThan(0);
    expect(enriched.XYZUNK?.analystRating).toBeTruthy();
  });

  it("noopProvider alias points to the mock provider", async () => {
    // noopProvider is now an alias for mockEnrichmentProvider.
    expect(noopProvider).toBe(mockEnrichmentProvider);
    expect(noopProvider.configured).toBe(true);
    const result = await noopProvider.enrich(["AAPL"]);
    expect(result.AAPL?.sector).toBe("Technology");
  });
});

describe("scoreHeadlines", () => {
  it("returns neutral 50 with no headlines or no signal words", () => {
    expect(scoreHeadlines([])).toBe(50);
    expect(scoreHeadlines(["Company holds annual meeting"])).toBe(50);
  });

  it("scores positive headlines above 50 and negative below 50", () => {
    expect(scoreHeadlines(["Stock surges as company beats earnings and raises guidance"])).toBeGreaterThan(50);
    expect(scoreHeadlines(["Shares plunge on downgrade and profit warning"])).toBeLessThan(50);
  });

  it("does not saturate at 100 even with many positive words", () => {
    const score = scoreHeadlines([
      "surge surge surge beats beats record growth gains rally jumps outperform"
    ]);
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThanOrEqual(95); // damped + clamped, never a hard 100
  });
});

describe("analyst scoring helpers", () => {
  it("maps rating distributions to a 0–100 score", () => {
    expect(analystScoreFromCounts({ strongBuy: 10, buy: 0, hold: 0, sell: 0, strongSell: 0 })).toBe(100);
    expect(analystScoreFromCounts({ strongBuy: 0, buy: 0, hold: 10, sell: 0, strongSell: 0 })).toBe(50);
    expect(analystScoreFromCounts({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 10 })).toBe(0);
    expect(analystScoreFromCounts({ strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 })).toBeUndefined();
  });

  it("maps a 1–5 analyst mean to a 0–100 score", () => {
    expect(analystScoreFromMean(1)).toBe(100); // strong buy
    expect(analystScoreFromMean(3)).toBe(50); // hold
    expect(analystScoreFromMean(5)).toBe(0); // strong sell
  });

  it("labels scores on the Strong Buy … Strong Sell scale", () => {
    expect(labelFromAnalystScore(95)).toBe("Strong Buy");
    expect(labelFromAnalystScore(70)).toBe("Buy");
    expect(labelFromAnalystScore(50)).toBe("Hold");
    expect(labelFromAnalystScore(30)).toBe("Sell");
    expect(labelFromAnalystScore(10)).toBe("Strong Sell");
  });
});

describe("isTransientError", () => {
  it("detects transient errors correctly", () => {
    expect(isTransientError(new Error("rate limit exceeded"))).toBe(true);
    expect(isTransientError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isTransientError(new Error("timeout of 5000ms exceeded"))).toBe(true);
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError(new Error("failed to fetch"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("HTTP 504 Gateway Timeout"))).toBe(true);
    expect(isTransientError(new Error("database error"))).toBe(false);
    expect(isTransientError(new Error("HTTP 404 Not Found"))).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

// ── Consent-gated enrichment cache ─────────────────────────────────────────────
// Verifies that data pulled with a user's own stored API key is:
//   - NOT visible to a different non-consenting user (private scope)
//   - IS shared via the pool to a consenting user (pool scope)
//   - env-keyed data remains globally shared (shared scope) as before
//
// This mirrors the exact same privacy contract implemented in src/lib/history.ts.
describe("enrichment cache consent gate", () => {
  // Each test needs a fresh cache + db so key/consent state doesn't bleed.
  beforeEach(async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY;
  });

  it("user-keyed data is private: invisible to a non-consenting second user", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { upsertUserApiKey } = await import("../src/lib/db");
    clearEnrichmentCache();

    const userA = `cg-priv-a-${randomUUID()}`;
    const userB = `cg-priv-b-${randomUUID()}`;
    // userA has their own API key; userB does NOT have an API key
    upsertUserApiKey(userA, "finnhub", "user-a-finnhub-key");

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      // Return a minimal success: profile2 gives companyName, everything else empty
      if (String(url).includes("profile2")) {
        return new Response(JSON.stringify({ name: "Acme Corp" }));
      }
      return new Response(JSON.stringify({}));
    });

    // userA fetches — source is "user", no consent → scope = "private"
    const providerA = new FinnhubEnrichmentProvider("user-a-finnhub-key", "user", userA);
    const resA = await providerA.enrich(["AAPL"]);
    expect(resA.AAPL?.companyName).toBe("Acme Corp");
    expect(fetchCount).toBe(5); // 5 Finnhub sub-calls (news, quote, rec, profile2, metric)

    // userB (no consent) tries with their own env-keyed provider — should NOT see userA's cache
    // To isolate the cache check, we make fetch throw so any cache miss would propagate as empty
    vi.stubGlobal("fetch", async () => { throw new Error("no network"); });
    const providerB = new FinnhubEnrichmentProvider("some-env-key", "env", userB);
    const resB = await providerB.enrich(["AAPL"]);
    // env-key provider reads shared scope — userA's private entry is not visible there
    expect(resB.AAPL?.companyName).toBeUndefined();
  });

  it("user-keyed data is shared via pool to a consenting second user", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    const { upsertUserApiKey, setDataPoolConsent } = await import("../src/lib/db");
    clearEnrichmentCache();

    const userA = `cg-pool-a-${randomUUID()}`;
    const userB = `cg-pool-b-${randomUUID()}`;
    // Both users consent to the data pool
    upsertUserApiKey(userA, "finnhub", "user-a-finnhub-key");
    setDataPoolConsent(userA, true);
    setDataPoolConsent(userB, true);

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (String(url).includes("profile2")) {
        return new Response(JSON.stringify({ name: "Pool Corp" }));
      }
      return new Response(JSON.stringify({}));
    });

    // userA fetches — user-key + consent → scope = "pool"
    const providerA = new FinnhubEnrichmentProvider("user-a-finnhub-key", "user", userA);
    const resA = await providerA.enrich(["AAPL"]);
    expect(resA.AAPL?.companyName).toBe("Pool Corp");
    expect(fetchCount).toBe(5);

    // userB (consenting) reads from the pool — no fetch should be needed
    const providerB = new FinnhubEnrichmentProvider("user-b-finnhub-key", "user", userB);
    const resB = await providerB.enrich(["AAPL"]);
    expect(resB.AAPL?.companyName).toBe("Pool Corp");
    // Pool hit — no additional fetch calls
    expect(fetchCount).toBe(5);
  });

  it("env-keyed data remains globally shared regardless of user or consent", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const userA = `cg-env-a-${randomUUID()}`;
    const userB = `cg-env-b-${randomUUID()}`;

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (String(url).includes("profile2")) {
        return new Response(JSON.stringify({ name: "Env Corp" }));
      }
      return new Response(JSON.stringify({}));
    });

    // userA uses env key — source = "env" → always shared scope
    const providerA = new FinnhubEnrichmentProvider("env-finnhub-key", "env", userA);
    await providerA.enrich(["AAPL"]);
    expect(fetchCount).toBe(5);

    // userB (no consent) uses env key — should hit the shared cache, no new fetch
    const providerB = new FinnhubEnrichmentProvider("env-finnhub-key", "env", userB);
    const resB = await providerB.enrich(["AAPL"]);
    expect(resB.AAPL?.companyName).toBe("Env Corp");
    expect(fetchCount).toBe(5); // shared cache hit — no additional fetches
  });

  it("MARKET_DATA_SHARE_USER_KEYED_HISTORY=on promotes user-key data to shared scope", async () => {
    process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY = "on";
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const userA = `cg-share-a-${randomUUID()}`;
    const userB = `cg-share-b-${randomUUID()}`;

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (String(url).includes("profile2")) {
        return new Response(JSON.stringify({ name: "Share Corp" }));
      }
      return new Response(JSON.stringify({}));
    });

    // userA's user-key → forced to shared because of the env override
    const providerA = new FinnhubEnrichmentProvider("user-a-finnhub-key", "user", userA);
    await providerA.enrich(["AAPL"]);
    expect(fetchCount).toBe(5);

    // userB (no consent, no user key) can read from shared scope
    const providerB = new FinnhubEnrichmentProvider("user-a-finnhub-key", "user", userB);
    const resB = await providerB.enrich(["AAPL"]);
    expect(resB.AAPL?.companyName).toBe("Share Corp");
    expect(fetchCount).toBe(5); // shared cache hit
  });
});

describe("Finnhub & FMP Cache Poisoning Protection", () => {
  it("prevents cache writes on Finnhub when a transient error occurs", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (url.includes("quote")) {
        return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
      }
      return new Response(JSON.stringify({}));
    });

    const provider = new FinnhubEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({});
    expect(fetchCount).toBe(6);

    const res2 = await provider.enrich(["AAPL"]);
    expect(res2.AAPL).toEqual({});
    expect(fetchCount).toBe(12);
  });

  it("caches normally on Finnhub when all queries succeed", async () => {
    const { FinnhubEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (url.includes("profile2")) {
        return new Response(JSON.stringify({ name: "Apple" }));
      }
      return new Response(JSON.stringify({}));
    });

    const provider = new FinnhubEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({ companyName: "Apple" });
    expect(fetchCount).toBe(5);

    const res2 = await provider.enrich(["AAPL"]);
    expect(res2.AAPL).toEqual({ companyName: "Apple" });
    expect(fetchCount).toBe(5);
  });

  it("prevents cache writes on FMP when a transient error occurs", async () => {
    const { FmpEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (url.includes("ratios-ttm")) {
        return new Response("Gateway Timeout", { status: 504 });
      }
      return new Response(JSON.stringify([]));
    });

    const provider = new FmpEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({});
    expect(fetchCount).toBe(4);

    const res2 = await provider.enrich(["AAPL"]);
    expect(res2.AAPL).toEqual({});
    expect(fetchCount).toBe(8);
  });

  it("caches normally on FMP when all queries succeed", async () => {
    const { FmpEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetchCount++;
      if (url.includes("ratios-ttm")) {
        return new Response(JSON.stringify([{ priceToEarningsRatioTTM: "25.5" }]));
      }
      return new Response(JSON.stringify([]));
    });

    const provider = new FmpEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({ peRatio: 25.5 });
    expect(fetchCount).toBe(4);

    const res2 = await provider.enrich(["AAPL"]);
    expect(res2.AAPL).toEqual({ peRatio: 25.5 });
    expect(fetchCount).toBe(4);
  });
});

describe("Alpha Vantage Warning Detection", () => {
  it("throws error and does not cache when Alpha Vantage returns HTTP 200 with Note", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({
        Note: "Thank you for using Alpha Vantage! Standard rate limit is 25 requests per day..."
      }));
    });

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({});
    expect(fetchCount).toBe(1);

    const res2 = await provider.enrich(["AAPL"]);
    expect(res2.AAPL).toEqual({});
    expect(fetchCount).toBe(2);
  });

  it("caches normally on Alpha Vantage when response has news feed", async () => {
    const { AlphaVantageEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({
        feed: [
          {
            title: "AAPL is doing great",
            ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.2" }]
          }
        ]
      }));
    });

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"]);
    expect(res1.AAPL).toEqual({ headlines: ["AAPL is doing great"], sentiment: 70 });
    expect(fetchCount).toBe(1);

    const res2 = await provider.enrich(["AAPL"]);
    expect(res2.AAPL).toEqual({ headlines: ["AAPL is doing great"], sentiment: 70 });
    expect(fetchCount).toBe(1);
  });

  describe("Fintech Studios / PowerIntell", () => {
    it("adds FintechStudiosEnrichmentProvider to cascade when key is set", async () => {
      process.env.FINTECH_STUDIOS_API_KEY = "test-key-fts";
      const provider = getEnrichmentProvider();
      expect(provider.name).toContain("fintechstudios");
    });

    it("fetches news and computes sentiment correctly", async () => {
      const { FintechStudiosEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      let fetchCount = 0;
      let requestedUrl = "";
      let requestedBody: any = null;

      vi.stubGlobal("fetch", async (url: string, init: any) => {
        fetchCount++;
        requestedUrl = url;
        requestedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          data: {
            articles: [
              { title: "Apple surges on new AI model launch" },
              { title: "Caterpillar logs steady growth" } // Wait, this is just mocked search articles
            ]
          }
        }));
      });

      const provider = new FintechStudiosEnrichmentProvider("fts-key");
      const res = await provider.enrich(["AAPL"]);

      expect(fetchCount).toBe(1);
      expect(requestedUrl).toBe("https://studio.fintechstudios.com/api/v1/search");
      expect(requestedBody).toEqual({ query: "AAPL stock", limit: 5 });
      expect(res.AAPL).toEqual({
        headlines: [
          "Apple surges on new AI model launch",
          "Caterpillar logs steady growth"
        ],
        sentiment: 76
      });
      // Verify cache works
      const resCached = await provider.enrich(["AAPL"]);
      expect(fetchCount).toBe(1);
      expect(resCached.AAPL).toEqual(res.AAPL);
    });

    it("prevents cache writes on transient errors", async () => {
      const { FintechStudiosEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
      clearEnrichmentCache();

      let fetchCount = 0;
      vi.stubGlobal("fetch", async () => {
        fetchCount++;
        return new Response("Internal Server Error", { status: 500 });
      });

      const provider = new FintechStudiosEnrichmentProvider("fts-key");
      const res1 = await provider.enrich(["AAPL"]);
      expect(res1.AAPL).toEqual({});
      expect(fetchCount).toBe(1);

      const res2 = await provider.enrich(["AAPL"]);
      expect(res2.AAPL).toEqual({});
      expect(fetchCount).toBe(2);
    });
  });
});

// ── AlpacaSnapshotEnrichmentProvider ─────────────────────────────────────────

describe("parseAlpacaSnapshot", () => {
  it("maps a full snapshot to the correct SymbolEnrichment fields", () => {
    const snap = {
      latestTrade: { p: 205.75 },
      latestQuote: { bp: 205.50, ap: 205.80 },
      dailyBar: { o: 203.00, h: 206.50, l: 202.00, c: 205.60, v: 1_250_000, vw: 204.42 },
      prevDailyBar: { c: 200.00 }
    };
    const result = parseAlpacaSnapshot(snap);
    expect(result.price).toBe(205.75);         // latestTrade.p preferred over dailyBar.c
    expect(result.bid).toBe(205.50);
    expect(result.ask).toBe(205.80);
    expect(result.volume).toBe(1_250_000);
    expect(result.vwap).toBe(204.42);          // dailyBar.vw mapped to vwap
    // (205.60 - 200.00) / 200.00 * 100 = 2.80%
    expect(result.intradayChangePct).toBeCloseTo(2.80, 2);
  });

  it("maps dailyBar.vw to vwap only when it is a positive number", () => {
    const result = parseAlpacaSnapshot({
      latestTrade: { p: 12.34 },
      dailyBar: { c: 12.34, v: 100_000, vw: 12.31 }
    });
    expect(result.vwap).toBe(12.31);
  });

  it("omits vwap when dailyBar.vw is missing or zero", () => {
    // vw absent entirely
    const noVw = parseAlpacaSnapshot({
      latestTrade: { p: 50.00 },
      dailyBar: { c: 50.00, v: 10_000 }
    });
    expect(noVw).not.toHaveProperty("vwap");

    // vw present but zero — never fabricate
    const zeroVw = parseAlpacaSnapshot({
      latestTrade: { p: 50.00 },
      dailyBar: { c: 50.00, v: 10_000, vw: 0 }
    });
    expect(zeroVw).not.toHaveProperty("vwap");

    // vw negative — never fabricate
    const negVw = parseAlpacaSnapshot({
      latestTrade: { p: 50.00 },
      dailyBar: { c: 50.00, v: 10_000, vw: -1 }
    });
    expect(negVw).not.toHaveProperty("vwap");
  });

  it("falls back to dailyBar.c for price when latestTrade is absent", () => {
    const snap = {
      latestQuote: { bp: 100.00, ap: 100.10 },
      dailyBar: { c: 100.05, v: 500_000 },
      prevDailyBar: { c: 98.00 }
    };
    const result = parseAlpacaSnapshot(snap);
    expect(result.price).toBe(100.05);
    // (100.05 - 98.00) / 98.00 * 100 ≈ 2.09%
    expect(result.intradayChangePct).toBeCloseTo(2.09, 1);
  });

  it("omits bid/ask when they are absent or zero", () => {
    const snap = {
      latestTrade: { p: 50.00 },
      latestQuote: { bp: 0, ap: undefined as unknown as number },
      dailyBar: { c: 50.00, v: 10_000 },
      prevDailyBar: { c: 49.00 }
    };
    const result = parseAlpacaSnapshot(snap);
    expect(result.price).toBe(50.00);
    expect(result).not.toHaveProperty("bid");
    expect(result).not.toHaveProperty("ask");
  });

  it("omits intradayChangePct when prevDailyBar is missing", () => {
    const snap = {
      latestTrade: { p: 75.00 },
      latestQuote: { bp: 74.90, ap: 75.10 },
      dailyBar: { c: 75.00, v: 300_000 }
      // no prevDailyBar
    };
    const result = parseAlpacaSnapshot(snap);
    expect(result.price).toBe(75.00);
    expect(result.bid).toBe(74.90);
    expect(result.ask).toBe(75.10);
    expect(result).not.toHaveProperty("intradayChangePct");
  });

  it("returns an empty object for a null/undefined snapshot", () => {
    expect(parseAlpacaSnapshot(null)).toEqual({});
    expect(parseAlpacaSnapshot(undefined)).toEqual({});
  });
});

describe("alpacaDataFeed", () => {
  const original = process.env.ALPACA_DATA_FEED;
  afterEach(() => {
    if (original === undefined) delete process.env.ALPACA_DATA_FEED;
    else process.env.ALPACA_DATA_FEED = original;
  });

  it("defaults to iex when unset", () => {
    delete process.env.ALPACA_DATA_FEED;
    expect(alpacaDataFeed()).toBe("iex");
  });

  it("honors the allowed feeds (iex|sip|otc), case-insensitively", () => {
    process.env.ALPACA_DATA_FEED = "sip";
    expect(alpacaDataFeed()).toBe("sip");
    process.env.ALPACA_DATA_FEED = "OTC";
    expect(alpacaDataFeed()).toBe("otc");
    process.env.ALPACA_DATA_FEED = "  IEX  ";
    expect(alpacaDataFeed()).toBe("iex");
  });

  it("falls back to iex for any disallowed value", () => {
    process.env.ALPACA_DATA_FEED = "delayed_sip";
    expect(alpacaDataFeed()).toBe("iex");
    process.env.ALPACA_DATA_FEED = "";
    expect(alpacaDataFeed()).toBe("iex");
  });
});

describe("AlpacaSnapshotEnrichmentProvider", () => {
  const originalFeed = process.env.ALPACA_DATA_FEED;
  beforeEach(async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFeed === undefined) delete process.env.ALPACA_DATA_FEED;
    else process.env.ALPACA_DATA_FEED = originalFeed;
  });

  it("honors ALPACA_DATA_FEED in the request URL and maps vwap from dailyBar.vw", async () => {
    process.env.ALPACA_DATA_FEED = "sip";
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          AAPL: {
            latestTrade: { p: 195.50 },
            latestQuote: { bp: 195.40, ap: 195.60 },
            dailyBar: { c: 195.30, v: 2_000_000, vw: 195.12 },
            prevDailyBar: { c: 192.00 }
          }
        })
      );
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("key-id", "key-secret", "env");
    const result = await provider.enrich(["AAPL"]);

    expect(capturedUrl).toContain("feed=sip");
    expect(capturedUrl).not.toContain("feed=iex");
    expect(result.AAPL?.vwap).toBe(195.12);
  });

  it("uses feed=iex in the request URL when ALPACA_DATA_FEED is unset", async () => {
    delete process.env.ALPACA_DATA_FEED;
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          AAPL: { latestTrade: { p: 1 }, dailyBar: { c: 1, v: 1 }, prevDailyBar: { c: 1 } }
        })
      );
    });
    const provider = new AlpacaSnapshotEnrichmentProvider("k", "s", "env");
    await provider.enrich(["AAPL"]);
    expect(capturedUrl).toContain("feed=iex");
  });

  it("fetches the snapshots endpoint with correct headers and maps fields", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          AAPL: {
            latestTrade: { p: 195.50 },
            latestQuote: { bp: 195.40, ap: 195.60 },
            dailyBar: { o: 193.00, h: 196.00, l: 192.00, c: 195.30, v: 2_000_000 },
            prevDailyBar: { c: 192.00 }
          },
          MSFT: {
            latestTrade: { p: 421.10 },
            latestQuote: { bp: 421.00, ap: 421.20 },
            dailyBar: { o: 418.00, h: 422.00, l: 417.00, c: 421.00, v: 800_000 },
            prevDailyBar: { c: 418.00 }
          }
        })
      );
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("key-id", "key-secret", "env");
    const result = await provider.enrich(["AAPL", "MSFT"]);

    // Headers
    expect(capturedHeaders["APCA-API-KEY-ID"]).toBe("key-id");
    expect(capturedHeaders["APCA-API-SECRET-KEY"]).toBe("key-secret");
    // URL contains both symbols and the iex feed
    expect(capturedUrl).toContain("feed=iex");
    expect(capturedUrl).toContain("AAPL");
    expect(capturedUrl).toContain("MSFT");

    // AAPL
    expect(result.AAPL?.price).toBe(195.50);
    expect(result.AAPL?.bid).toBe(195.40);
    expect(result.AAPL?.ask).toBe(195.60);
    expect(result.AAPL?.volume).toBe(2_000_000);
    // (195.30 - 192.00) / 192.00 * 100 = 1.72%
    expect(result.AAPL?.intradayChangePct).toBeCloseTo(1.72, 1);

    // MSFT
    expect(result.MSFT?.price).toBe(421.10);
    expect(result.MSFT?.bid).toBe(421.00);
    expect(result.MSFT?.ask).toBe(421.20);
    expect(result.MSFT?.volume).toBe(800_000);
    // (421.00 - 418.00) / 418.00 * 100 = 0.72%
    expect(result.MSFT?.intradayChangePct).toBeCloseTo(0.72, 1);
  });

  it("caches results and avoids a second network call", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          AAPL: {
            latestTrade: { p: 200.00 },
            latestQuote: { bp: 199.90, ap: 200.10 },
            dailyBar: { c: 200.00, v: 1_000_000 },
            prevDailyBar: { c: 198.00 }
          }
        })
      );
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("k", "s");
    const r1 = await provider.enrich(["AAPL"]);
    expect(r1.AAPL?.price).toBe(200.00);
    expect(fetchCount).toBe(1);

    const r2 = await provider.enrich(["AAPL"]);
    expect(r2.AAPL?.price).toBe(200.00);
    expect(fetchCount).toBe(1); // cache hit — no second fetch
  });

  it("returns empty objects on HTTP error and does not cache", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response("Unauthorized", { status: 401 });
    });

    const provider = new AlpacaSnapshotEnrichmentProvider("bad-key", "bad-secret");
    const r1 = await provider.enrich(["AAPL"]);
    expect(r1.AAPL).toEqual({});
    expect(fetchCount).toBe(1);

    // No cache written — second call should hit network again
    const r2 = await provider.enrich(["AAPL"]);
    expect(r2.AAPL).toEqual({});
    expect(fetchCount).toBe(2);
  });

  it("does not fabricate bid/ask when the snapshot has zero quotes", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          TSLA: {
            latestTrade: { p: 175.00 },
            latestQuote: { bp: 0, ap: 0 }, // zero = not available, must not be set
            dailyBar: { c: 175.00, v: 500_000 },
            prevDailyBar: { c: 172.00 }
          }
        })
      )
    );

    const provider = new AlpacaSnapshotEnrichmentProvider("k", "s");
    const result = await provider.enrich(["TSLA"]);
    expect(result.TSLA?.price).toBe(175.00);
    expect(result.TSLA).not.toHaveProperty("bid");
    expect(result.TSLA).not.toHaveProperty("ask");
  });
});

// Freshness-tier ordering: the real-time Alpaca snapshot must win the price-family
// fields (price/bid/ask/volume) over a DELAYED provider that also returns them, because
// it is seated FIRST in the cascade. This locks in the reorder in getEnrichmentProvider.
describe("freshness-tier ordering — real-time Alpaca wins price-family fields", () => {
  const originalFinnhubKey = process.env.FINNHUB_API_KEY;
  const originalAlpacaKey = process.env.ALPACA_PAPER_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_PAPER_SECRET_KEY;

  beforeEach(async () => {
    const { clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();
    process.env.ALPACA_PAPER_API_KEY = "alpaca-key";
    process.env.ALPACA_PAPER_SECRET_KEY = "alpaca-secret";
    process.env.FINNHUB_API_KEY = "finnhub-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFinnhubKey) process.env.FINNHUB_API_KEY = originalFinnhubKey;
    else delete process.env.FINNHUB_API_KEY;
    if (originalAlpacaKey) process.env.ALPACA_PAPER_API_KEY = originalAlpacaKey;
    else delete process.env.ALPACA_PAPER_API_KEY;
    if (originalAlpacaSecret) process.env.ALPACA_PAPER_SECRET_KEY = originalAlpacaSecret;
    else delete process.env.ALPACA_PAPER_SECRET_KEY;
  });

  it("seats alpaca-snapshot ahead of the delayed finnhub provider in the cascade", () => {
    const provider = getEnrichmentProvider();
    const order = provider.name.split("+");
    expect(order).toContain("alpaca-snapshot");
    expect(order).toContain("finnhub");
    // Real-time tier must resolve before the delayed quote/fundamentals tier.
    expect(order.indexOf("alpaca-snapshot")).toBeLessThan(order.indexOf("finnhub"));
  });

  it("takes Alpaca's real-time price/bid/ask/volume over a delayed provider's value", async () => {
    // Alpaca's real-time snapshot and Finnhub's delayed quote BOTH return a volume for
    // AAPL, but with DIFFERENT numbers. The first-wins cascade must keep Alpaca's because
    // it is seated first. Route fetch by host so each provider gets its own payload; every
    // other URL (Finnhub's other 4 endpoints, Yahoo's crumb/quoteSummary) returns benign empty.
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("data.alpaca.markets/v2/stocks/snapshots")) {
        return new Response(
          JSON.stringify({
            AAPL: {
              latestTrade: { p: 195.50 },
              latestQuote: { bp: 195.40, ap: 195.60 },
              dailyBar: { c: 195.30, v: 2_000_000 },
              prevDailyBar: { c: 192.00 }
            }
          })
        );
      }
      if (url.includes("finnhub.io/api/v1/quote")) {
        // Delayed quote: a DIFFERENT (stale) volume that must lose to Alpaca's.
        return new Response(JSON.stringify({ c: 190.00, v: 9_999_999 }));
      }
      // Finnhub company-news returns an array; everything else an empty object/array.
      if (url.includes("finnhub.io/api/v1/company-news")) return new Response(JSON.stringify([]));
      if (url.includes("finnhub.io")) return new Response(JSON.stringify({}));
      // Yahoo crumb/quoteSummary and any other URL: empty so nothing throws.
      return new Response(JSON.stringify({}));
    });

    const provider = getEnrichmentProvider();
    const result = await provider.enrich(["AAPL"]);

    // Real-time Alpaca wins every price-family field…
    expect(result.AAPL?.price).toBe(195.50);
    expect(result.AAPL?.bid).toBe(195.40);
    expect(result.AAPL?.ask).toBe(195.60);
    // …including the field both providers returned (Alpaca 2,000,000 beats Finnhub 9,999,999).
    expect(result.AAPL?.volume).toBe(2_000_000);

    // …and each is stamped to the real-time source, proving Alpaca (not finnhub) supplied it.
    expect(result.AAPL?.sources?.price).toBe("alpaca-snapshot");
    expect(result.AAPL?.sources?.bid).toBe("alpaca-snapshot");
    expect(result.AAPL?.sources?.ask).toBe("alpaca-snapshot");
    expect(result.AAPL?.sources?.volume).toBe("alpaca-snapshot");
  });
});
