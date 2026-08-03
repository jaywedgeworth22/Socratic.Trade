import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { clearHistoryCache, fetchDailyOHLC, parseStooqCsv, toBusinessDay } from "../src/lib/history";
import { clearMassiveRestBudgetForTests } from "../src/lib/market-signals/massive";
import { clearMarketDataDemandsForTests, deleteUserApiKey, getDb, upsertConnectedAccount, upsertUserApiKey } from "../src/lib/db";
import { subscribeDashboardEvents, type DashboardEvent } from "../src/lib/events";
import { admitProviderRequests, resetProviderQuotaState } from "../src/lib/provider-rate-limit";
import { apiKeyFingerprint } from "../src/lib/data-providers";

const historyTestDb = `file:${join(tmpdir(), `agentic-history-cache-test-${randomUUID()}.db`)}`;

beforeEach(() => {
  process.env.DATABASE_URL = historyTestDb;
  clearHistoryCache();
  clearMarketDataDemandsForTests();
  clearMassiveRestBudgetForTests();
  // Keep the cascade on the (mocked) free sources — keyed providers are skipped without keys.
  delete process.env.MASSIVE_API_KEY;
  delete process.env.MASSIVE_REST_MAX_CALLS_PER_MINUTE;
  delete process.env.MASSIVE_HISTORY_ENABLED;
  delete process.env.MARKETSTACK_API_KEY;
  delete process.env.TIINGO_API_KEY;
  delete process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY;
  resetProviderQuotaState("tiingo");
  // Tiingo is per-user-only tier (db-api-keys.ts) — a prior test's upsertUserApiKey("local", "tiingo", …)
  // would otherwise persist across tests sharing historyTestDb, same concern as the Tradier row below.
  deleteUserApiKey("local", "tiingo");
  // Tradier's credential now comes from a connected_accounts row, not an env var — a prior test's
  // connectTradier() call would otherwise persist across tests sharing historyTestDb (unlike the
  // deleted env vars above, which reset per-test on their own).
  getDb().exec("DELETE FROM connected_accounts WHERE broker = 'tradier'");
});
afterEach(() => vi.unstubAllGlobals());

// Tradier's price-history credential comes from the "local" (owner's) connected broker account, not
// a stored API key — see resolveTradierHistoryCredential in src/lib/history.ts. Connects a fresh
// account each call; upsertConnectedAccount deactivates any prior active row for the user first, so
// this is safe to call repeatedly across tests sharing historyTestDb.
function connectTradier(token: string, environment: "paper" | "live" = "live", isActive = true): void {
  upsertConnectedAccount({
    id: `trd-history-${randomUUID()}`,
    userId: "local",
    broker: "tradier",
    environment,
    label: "Tradier Brokerage",
    apiKey: token,
    isActive
  });
}

describe("toBusinessDay", () => {
  it("normalizes ms-epoch, seconds-epoch, and date strings to YYYY-MM-DD", () => {
    expect(toBusinessDay(Date.UTC(2026, 5, 18))).toBe("2026-06-18"); // ms
    expect(toBusinessDay(Math.floor(Date.UTC(2026, 5, 18) / 1000))).toBe("2026-06-18"); // seconds
    expect(toBusinessDay("2026-06-18")).toBe("2026-06-18");
    expect(toBusinessDay("2026-06-18T14:00:00Z")).toBe("2026-06-18");
    expect(toBusinessDay(undefined)).toBeUndefined();
    expect(toBusinessDay("garbage")).toBeUndefined();
  });
});

describe("parseStooqCsv", () => {
  it("parses daily OHLC rows and skips the header", () => {
    const csv = `Date,Open,High,Low,Close,Volume
2026-06-16,10,11,9,10.5,1000
2026-06-17,10.5,12,10,11.8,2000`;
    const out = parseStooqCsv(csv);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ open: 10, high: 11, low: 9, close: 10.5, time: "2026-06-16" });
  });
});

describe("fetchDailyOHLC", () => {
  const tradierBody = JSON.stringify({
    history: {
      day: [
        { date: "2026-06-16", open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
        { date: "2026-06-17", open: 10.5, high: 12, low: 10, close: 11.8, volume: 2000 }
      ]
    }
  });

  const marketstackBody = JSON.stringify({
    data: [
      { date: "2026-06-16T00:00:00+0000", open: 20, high: 21, low: 19, close: 20.5, volume: 3000 },
      { date: "2026-06-17T00:00:00+0000", open: 20.5, high: 22, low: 20, close: 21.8, volume: 4000 }
    ]
  });

  // Second bar has a 2:1 split between raw close (60) and adjClose (30) — exercises the O/H/L scaling.
  const tiingoBody = JSON.stringify([
    { date: "2026-06-16T00:00:00.000Z", open: 30, high: 31, low: 29, close: 30, volume: 3000, adjOpen: 30, adjHigh: 31, adjLow: 29, adjClose: 30, adjVolume: 3000 },
    { date: "2026-06-17T00:00:00.000Z", open: 62, high: 64, low: 60, close: 60, volume: 4000, adjOpen: 31, adjHigh: 32, adjLow: 30, adjClose: 30, adjVolume: 8000 }
  ]);

  const yahooBody = (n: number) => {
    const timestamp = Array.from({ length: n }, (_, i) => Math.floor(Date.UTC(2025, 0, 1) / 1000) + i * 86_400);
    const arr = (base: number) => Array.from({ length: n }, (_, i) => base + i);
    const quote = [{ open: arr(100), high: arr(101), low: arr(99), close: arr(100), volume: arr(1000) }];
    return JSON.stringify({ chart: { result: [{ timestamp, indicators: { quote } }] } });
  };

  it("uses Tradier before free history sources when the key is set", async () => {
    connectTradier("tradier-test-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.tradier.com")
        ? new Response(tradierBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(2);
    expect(bars![0]).toMatchObject({ time: "2026-06-16", close: 10.5, volume: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.tradier.com");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer tradier-test-key" });
  });

  it("still uses Tradier for history when it's connected but NOT the active execution broker (Codex review, PR #1673)", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    // Alpaca is the account the user actually trades through (active); Tradier is connected
    // purely as a shared data source. "isActive" means "the currently loaded execution broker,"
    // an orthogonal concept to "this credential exists and can source history" — requiring
    // Tradier to ALSO be the active broker would silently disable this exact, intended setup.
    upsertConnectedAccount({
      id: `alpaca-history-${randomUUID()}`,
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      label: "Alpaca Paper",
      apiKey: "alpaca-key",
      apiSecret: "alpaca-secret",
      isActive: true
    });
    connectTradier("tradier-inactive-key", "live", false); // connected, but not active
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.tradier.com")
        ? new Response(tradierBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer tradier-inactive-key" });
  });

  it("uses Tiingo ahead of Marketstack, applying adjClose-scaled O/H/L", async () => {
    // Tiingo is a "per-user-only" credential tier (db-api-keys.ts) — TIINGO_API_KEY only reaches
    // resolveApiKeyWithSource via the one-time env→DB migration at startup, not a live per-call env
    // read (unlike Marketstack/Massive, which ARE shared-operator-infra). Store it the same way the
    // Connections page / that migration would, on the "local" user resolveApiKeyWithSource falls back
    // to when no specific userId is passed (the background/scan-time call shape fetchDailyOHLC uses here).
    upsertUserApiKey("local", "tiingo", "tiingo-history-test-key");
    process.env.MARKETSTACK_API_KEY = "marketstack-test-key"; // present but must be skipped — Tiingo wins first
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("api.tiingo.com")) return new Response(tiingoBody, { status: 200 });
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(2);
    expect(bars![0]).toMatchObject({ time: "2026-06-16", close: 30, volume: 3000 });
    // Second bar: adjClose(30)/close(60) = 0.5 factor scales raw open/high/low onto the adjusted basis.
    expect(bars![1]).toMatchObject({ time: "2026-06-17", open: 31, high: 32, low: 30, close: 30, volume: 8000 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.tiingo.com/tiingo/daily/aapl/prices");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Token tiingo-history-test-key" });
    // Marketstack must never be reached — Tiingo already satisfied the cascade.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.marketstack.com"))).toBe(false);
  });

  it("falls through to Marketstack when Tiingo's hourly/daily budget is already exhausted", async () => {
    upsertUserApiKey("local", "tiingo", "tiingo-history-test-key");
    process.env.MARKETSTACK_API_KEY = "marketstack-test-key";
    // Drain the SAME "tiingo" quota bucket TiingoEnrichmentProvider would share, from outside this call.
    const credKey = await apiKeyFingerprint("tiingo-history-test-key");
    admitProviderRequests("tiingo", credKey, 50); // exhausts the 50/hour default
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("api.marketstack.com")) return new Response(marketstackBody, { status: 200 });
      return new Response("unexpected source (Tiingo should have been skipped, not called)", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars![0]).toMatchObject({ close: 20.5 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.tiingo.com"))).toBe(false);
  });

  it("falls back from Tradier to Marketstack before free sources", async () => {
    connectTradier("tradier-test-key");
    process.env.MARKETSTACK_API_KEY = "marketstack-test-key";
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("api.tradier.com")) return new Response("tradier down", { status: 500 });
      if (String(url).includes("api.marketstack.com")) return new Response(marketstackBody, { status: 200 });
      return new Response("unexpected source", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(2);
    expect(bars![0]).toMatchObject({ time: "2026-06-16T00:00:00+0000", close: 20.5, volume: 3000 });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("api.tradier.com"),
      expect.stringContaining("api.tradier.com"),
      expect.stringContaining("api.marketstack.com")
    ]);
  });

  it("skips Massive when the local REST budget is exhausted and falls through to free history", async () => {
    process.env.MASSIVE_API_KEY = "massive-test-key";
    process.env.MASSIVE_REST_MAX_CALLS_PER_MINUTE = "0";
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com") ? new Response(yahooBody(60), { status: 200 }) : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.UTC(2026, 5, 18));

    expect(bars).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("query1.finance.yahoo.com");
  });

  it("fetches Yahoo OHLC and caches the result (one network call across two reads)", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com") ? new Response(yahooBody(60), { status: 200 }) : new Response("nope", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const now = Date.UTC(2026, 5, 18);
    const first = await fetchDailyOHLC("AAPL", now);
    expect(first).not.toBeNull();
    expect(first!.length).toBe(60);
    expect(first![0]).toMatchObject({ open: 100, high: 101, low: 99, close: 100 });

    const second = await fetchDailyOHLC("AAPL", now + 1000); // within TTL → cache hit
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expire a Saturday-written cache entry before Monday's open (LANE A weekend-stable TTL)", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com") ? new Response(yahooBody(60), { status: 200 }) : new Response("nope", { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const saturday = Date.UTC(2026, 5, 20, 12, 0, 0); // Sat 2026-06-20, noon UTC (8am EDT — still Saturday)
    const sunday = Date.UTC(2026, 5, 21, 12, 0, 0); // Sun 2026-06-21, noon UTC — 24h later, well past the
    // naive 30-min OHLC TTL, but still inside the same weekend closed stretch.

    const first = await fetchDailyOHLC("AAPL", saturday);
    expect(first).not.toBeNull();

    const second = await fetchDailyOHLC("AAPL", sunday);
    expect(second).toBe(first); // still cached — the market hasn't traded since Saturday
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares Tradier's connected-account-sourced history across users (always shared, not per-user)", async () => {
    connectTradier("env-tradier-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.tradier.com")
        ? new Response(tradierBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.UTC(2026, 5, 18);

    const first = await fetchDailyOHLC("AAPL", now, `user-a-${randomUUID()}`);
    const second = await fetchDailyOHLC("AAPL", now + 1000, `user-b-${randomUUID()}`);

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer env-tradier-key" });
  });

  it("keeps user-keyed history cache entries private by default", async () => {
    const userA = `history-user-a-${randomUUID()}`;
    const userB = `history-user-b-${randomUUID()}`;
    upsertUserApiKey(userA, "marketstack", "user-a-marketstack-key");
    upsertUserApiKey(userB, "marketstack", "user-b-marketstack-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.marketstack.com")
        ? new Response(marketstackBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.UTC(2026, 5, 18);

    await fetchDailyOHLC("AAPL", now, userA);
    await fetchDailyOHLC("AAPL", now + 1000, userB);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("access_key=user-a-marketstack-key"),
      expect.stringContaining("access_key=user-b-marketstack-key")
    ]);
  });

  it("shares user-keyed history only when explicitly opted in", async () => {
    process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY = "on";
    const userA = `history-shared-a-${randomUUID()}`;
    const userB = `history-shared-b-${randomUUID()}`;
    upsertUserApiKey(userA, "marketstack", "user-a-marketstack-key");
    upsertUserApiKey(userB, "marketstack", "user-b-marketstack-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.marketstack.com")
        ? new Response(marketstackBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.UTC(2026, 5, 18);

    const first = await fetchDailyOHLC("AAPL", now, userA);
    const second = await fetchDailyOHLC("AAPL", now + 1000, userB);

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("access_key=user-a-marketstack-key");
  });

  it("fulfills old shared history misses when a later shared cache fill succeeds", async () => {
    const events: DashboardEvent[] = [];
    const unsubscribe = subscribeDashboardEvents((event) => events.push(event));
    const now = Date.UTC(2026, 5, 18);
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));

    await expect(fetchDailyOHLC("XYZ", now, `alice-${randomUUID()}`)).resolves.toBeNull();

    connectTradier("env-tradier-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.tradier.com")
        ? new Response(tradierBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const bars = await fetchDailyOHLC("XYZ", now + 120_000, `frank-${randomUUID()}`);
    unsubscribe();

    expect(bars).not.toBeNull();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "market-data",
        detail: expect.objectContaining({ kind: "history", cacheScope: "shared", pendingUserCount: 1 })
      })
    );
  });

  it("does not fulfill old shared history misses from private user-key fills", async () => {
    const events: DashboardEvent[] = [];
    const unsubscribe = subscribeDashboardEvents((event) => events.push(event));
    const now = Date.UTC(2026, 5, 18);
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));

    await expect(fetchDailyOHLC("XYZ", now, `alice-${randomUUID()}`)).resolves.toBeNull();

    const frank = `frank-${randomUUID()}`;
    upsertUserApiKey(frank, "marketstack", "frank-marketstack-key");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes("api.marketstack.com")
        ? new Response(marketstackBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const bars = await fetchDailyOHLC("XYZ", now + 120_000, frank);
    unsubscribe();

    expect(bars).not.toBeNull();
    expect(events.filter((event) => event.type === "market-data")).toHaveLength(0);
  });

  it("no longer falls back to Stooq when Yahoo yields nothing (tier removed 2026-08 — bot-walled)", async () => {
    const stooq = `Date,Open,High,Low,Close,Volume\n2026-06-16,10,11,9,10.5,1000\n2026-06-17,10.5,12,10,11.8,2000`;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("query1.finance.yahoo.com")) return new Response(JSON.stringify({ chart: { result: [{}] } }), { status: 200 });
      if (String(url).includes("stooq.com")) return new Response(stooq, { status: 200 });
      return new Response("nope", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const bars = await fetchDailyOHLC("BBB");
    expect(bars).toBeNull();
    // Stooq must never even be called — its endpoint sits behind a proof-of-work bot wall.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("stooq.com"))).toBe(false);
  });

  it("returns null when no source has data (never fabricates)", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    expect(await fetchDailyOHLC("ZZZ")).toBeNull();
  });

  it("serves local 5-year flat-file OHLC history directly without network requests", async () => {
    const { fetchLocalFlatFileHistory } = await import("../src/lib/history");
    const fs = await import("fs");
    const path = await import("path");
    const testDir = path.join(process.cwd(), "data", "history-5y");
    const testFile = path.join(testDir, "TESTSYM.json");

    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      testFile,
      JSON.stringify([
        { t: 1609459200000, o: 100, h: 105, l: 99, c: 104, v: 1000 },
        { t: 1609545600000, o: 104, h: 108, l: 103, c: 107, v: 1500 }
      ])
    );

    try {
      const bars = fetchLocalFlatFileHistory("TESTSYM");
      expect(bars).not.toBeNull();
      expect(bars).toHaveLength(2);
      expect(bars![0].close).toBe(104);
      expect(bars![1].close).toBe(107);
    } finally {
      if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
    }
  });
});

describe("fetchDailyOHLC App A tier skip (peer-serving reads)", () => {
  const appABody = JSON.stringify({
    ticker: "AAPL",
    closes: [
      { date: "2026-06-17", close: 11.8 },
      { date: "2026-06-16", close: 10.5 }
    ]
  });

  const yahooBody = () => {
    const n = 250;
    const timestamp = Array.from({ length: n }, (_, i) => Math.floor(Date.UTC(2025, 0, 1) / 1000) + i * 86_400);
    const arr = (base: number) => Array.from({ length: n }, (_, i) => base + i);
    const quote = [{ open: arr(100), high: arr(101), low: arr(99), close: arr(100), volume: arr(1000) }];
    return JSON.stringify({ chart: { result: [{ timestamp, indicators: { quote } }] } });
  };

  beforeEach(() => {
    process.env.CONGRESS_TRADE_READS_ENABLED = "on";
  });
  afterEach(() => {
    delete process.env.CONGRESS_TRADE_READS_ENABLED;
  });

  it("consults the App A tier by default when reads are enabled (control)", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("congress.trade")
        ? new Response(appABody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL");
    expect(bars).toHaveLength(2);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("congress.trade"))).toBe(true);
  });

  it("skipAppATier never echoes the request back to App A and still serves from later tiers", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("finance.yahoo.com")
        ? new Response(yahooBody(), { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("AAPL", Date.now(), undefined, { skipAppATier: true });
    expect(bars).not.toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("congress.trade"))).toBe(false);
  });
});
