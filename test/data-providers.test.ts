import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analystScoreFromCounts,
  analystScoreFromMean,
  getEnrichmentProvider,
  isTransientError,
  labelFromAnalystScore,
  mockEnrichmentProvider,
  noopProvider,
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
