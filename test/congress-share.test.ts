import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OHLCBar } from "../src/lib/indicators";

// Mock the history cascade so tests never hit the network. Keep toBusinessDay (and everything else)
// real; only fetchDailyOHLC is replaced.
vi.mock("../src/lib/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/history")>();
  return { ...actual, fetchDailyOHLC: vi.fn() };
});

import { fetchDailyOHLC } from "../src/lib/history";
import { setInternalSetting } from "../src/lib/db";
import {
  buildInsiderImport,
  buildShortVolumeImport,
  chunkPrices,
  isCongressDailyShareDue,
  isCongressShareAutoEnabled,
  marketQuoteToRef,
  ohlcBarsToCloses,
  ohlcBarsToPriceEntry,
  resetCongressRefThrottle,
  runCongressDailyShare,
  runCongressDailyShareIfDue,
  shareScanRefs,
  shareWithCongressTrade,
  type CongressPrice
} from "../src/lib/congress-share";

const recentDate = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const mockedFetchDailyOHLC = vi.mocked(fetchDailyOHLC);

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-share-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  delete process.env.CONGRESS_TRADE_TOKEN;
  delete process.env.CONGRESS_SHARE_ENABLED;
  delete process.env.CONGRESS_TRADE_BASE_URL;
  resetCongressRefThrottle();
  mockedFetchDailyOHLC.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Mappers ─────────────────────────────────────────────────────────────────────

describe("marketQuoteToRef", () => {
  it("normalizes ticker, defaults assetClass to equity, and omits absent fields", () => {
    const ref = marketQuoteToRef({ symbol: "aapl", companyName: "Apple Inc.", sector: "Technology" });
    expect(ref).toEqual({ ticker: "AAPL", assetClass: "equity", companyName: "Apple Inc.", sector: "Technology" });
  });

  it("drops a non-positive / non-finite market cap", () => {
    expect(marketQuoteToRef({ symbol: "X", marketCap: 0 })?.marketCap).toBeUndefined();
    expect(marketQuoteToRef({ symbol: "X", marketCap: NaN })?.marketCap).toBeUndefined();
    expect(marketQuoteToRef({ symbol: "X", marketCap: 1_000 })?.marketCap).toBe(1_000);
  });

  it("returns null when there is no usable ticker", () => {
    expect(marketQuoteToRef({ symbol: "" })).toBeNull();
  });
});

describe("ohlcBarsToCloses", () => {
  it("maps to {date, close}, sorts ascending, and drops invalid bars", () => {
    const bars: OHLCBar[] = [
      { time: "2026-06-16", close: 101 },
      { time: "2026-06-15", close: 100 },
      { time: "2026-06-17", close: NaN }, // dropped (bad close)
      { time: undefined, close: 99 } // dropped (no date)
    ];
    expect(ohlcBarsToCloses(bars)).toEqual([
      { date: "2026-06-15", close: 100 },
      { date: "2026-06-16", close: 101 }
    ]);
  });

  it("dedupes by date (later bar wins) and accepts ms-epoch times", () => {
    const ms = Date.UTC(2026, 5, 15); // 2026-06-15
    const bars: OHLCBar[] = [
      { time: ms, close: 10 },
      { time: ms, close: 12 }
    ];
    expect(ohlcBarsToCloses(bars)).toEqual([{ date: "2026-06-15", close: 12 }]);
  });

  it("returns [] for empty/nullish input", () => {
    expect(ohlcBarsToCloses(null)).toEqual([]);
    expect(ohlcBarsToCloses([])).toEqual([]);
  });
});

describe("ohlcBarsToPriceEntry", () => {
  it("derives currentPrice/currentPriceDate from the most-recent close", () => {
    const entry = ohlcBarsToPriceEntry("msft", [
      { time: "2026-06-15", close: 100 },
      { time: "2026-06-16", close: 105 }
    ]);
    expect(entry).toEqual({
      ticker: "MSFT",
      closes: [
        { date: "2026-06-15", close: 100 },
        { date: "2026-06-16", close: 105 }
      ],
      currentPrice: 105,
      currentPriceDate: "2026-06-16"
    });
  });

  it("returns null when there are no valid closes", () => {
    expect(ohlcBarsToPriceEntry("MSFT", [])).toBeNull();
    expect(ohlcBarsToPriceEntry("", [{ time: "2026-06-16", close: 1 }])).toBeNull();
  });
});

describe("chunkPrices", () => {
  const mk = (ticker: string, n: number): CongressPrice => ({
    ticker,
    closes: Array.from({ length: n }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, close: i }))
  });

  it("packs by close budget", () => {
    const chunks = chunkPrices([mk("A", 60), mk("B", 60), mk("C", 60)], 100, 2000);
    expect(chunks.map((c) => c.map((p) => p.ticker))).toEqual([["A"], ["B"], ["C"]]);
  });

  it("packs by ticker count", () => {
    const chunks = chunkPrices([mk("A", 1), mk("B", 1), mk("C", 1), mk("D", 1)], 100_000, 2);
    expect(chunks.map((c) => c.map((p) => p.ticker))).toEqual([["A", "B"], ["C", "D"]]);
  });

  it("truncates a single ticker exceeding the close budget to the most-recent closes", () => {
    const [chunk] = chunkPrices([mk("BIG", 250)], 100, 2000);
    expect(chunk).toHaveLength(1);
    expect(chunk[0].closes).toHaveLength(100);
    expect(chunk[0].closes[0].close).toBe(150); // kept the last 100 (indices 150..249)
  });
});

// ── shareWithCongressTrade ────────────────────────────────────────────────────────

describe("shareWithCongressTrade", () => {
  it("skips (no fetch) when no token is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(res).toMatchObject({ ok: false, skipped: true, reason: "no-token" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips an empty payload", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await shareWithCongressTrade({});
    expect(res).toMatchObject({ ok: false, skipped: true, reason: "empty" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to the import endpoint with bearer auth + JSON body and returns the response", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "secret-token";
    process.env.CONGRESS_TRADE_BASE_URL = "https://congress.trade/";
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, refs: 1 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }], spx: [{ date: "2026-06-15", close: 5400 }] });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://congress.trade/api/admin/securities/import"); // trailing slash normalized
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      refs: [{ ticker: "AAPL" }],
      spx: [{ date: "2026-06-15", close: 5400 }],
      origin: "app-b" // no-echo-loop provenance tag stamped on every outbound payload
    });
    expect(res).toMatchObject({ ok: true, status: 200, response: { ok: true, refs: 1 }, sent: { refs: 1, spx: 1 } });
  });

  it("returns ok:false on an HTTP error without throwing", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it("returns ok:false on a transport error without throwing", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(res).toMatchObject({ ok: false, error: "network down" });
  });
});

// ── shareScanRefs (after-scan hook) ────────────────────────────────────────────────

describe("shareScanRefs", () => {
  const scan = { topCandidates: [{ symbol: "AAPL" }, { symbol: "MSFT" }] } as Parameters<typeof shareScanRefs>[0];

  it("is a no-op when automatic sharing is disabled", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok"; // token alone is not enough
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await shareScanRefs(scan)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs candidate refs once, then throttles repeat sends within the TTL", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_ENABLED = "on";
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const first = await shareScanRefs(scan);
    expect(first?.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.refs.map((r: { ticker: string }) => r.ticker)).toEqual(["AAPL", "MSFT"]);

    // Second scan with the same names: throttled → no new POST, returns null.
    expect(await shareScanRefs(scan)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rolls back the throttle so a failed send is retried on the next scan", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_ENABLED = "on";
    const fetchSpy = vi
      .fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    expect((await shareScanRefs(scan))?.ok).toBe(false);
    expect((await shareScanRefs(scan))?.ok).toBe(true); // retried, not throttled
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ── Nightly batch + gating ─────────────────────────────────────────────────────────

describe("isCongressShareAutoEnabled", () => {
  it("requires both the token and the enable flag", () => {
    expect(isCongressShareAutoEnabled()).toBe(false);
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    expect(isCongressShareAutoEnabled()).toBe(false);
    process.env.CONGRESS_SHARE_ENABLED = "true";
    expect(isCongressShareAutoEnabled()).toBe(true);
  });
});

describe("isCongressDailyShareDue", () => {
  it("is true until the marker matches the run's UTC date", () => {
    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-21");
    expect(isCongressDailyShareDue(now)).toBe(true);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-22");
    expect(isCongressDailyShareDue(now)).toBe(false);
  });
});

describe("runCongressDailyShare", () => {
  it("skips with no token", async () => {
    const res = await runCongressDailyShare({ force: true, symbols: ["AAPL"] });
    expect(res).toMatchObject({ ok: false, skipped: true, reason: "no-token" });
  });

  it("shares custom symbols + SPX in one POST and does not advance the daily marker", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const bars: OHLCBar[] = [
      { time: "2026-06-15", close: 100 },
      { time: "2026-06-16", close: 101 }
    ];
    mockedFetchDailyOHLC.mockResolvedValue(bars);
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-20"); // a known past marker
    const res = await runCongressDailyShare({ now, force: true, symbols: ["AAPL", "MSFT"] });

    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ tickers: 2, priced: 2, spxRows: 2, posts: 1, failedPosts: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.spx).toHaveLength(2);
    expect(body.prices.map((p: { ticker: string }) => p.ticker)).toEqual(["AAPL", "MSFT"]);
    // ^GSPC + the two tickers were fetched.
    expect(mockedFetchDailyOHLC).toHaveBeenCalledWith("^GSPC", now);
    // Custom-symbol runs must NOT advance the once-per-day marker.
    expect(isCongressDailyShareDue(now)).toBe(true);
  });

  it("skips when not due and not forced", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-22");
    const res = await runCongressDailyShare({ now });
    expect(res).toMatchObject({ ok: false, skipped: true, reason: "not-due" });
    expect(mockedFetchDailyOHLC).not.toHaveBeenCalled();
  });
});

describe("runCongressDailyShareIfDue", () => {
  it("returns null when automatic sharing is disabled", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok"; // no enable flag
    expect(await runCongressDailyShareIfDue(Date.now())).toBeNull();
    expect(mockedFetchDailyOHLC).not.toHaveBeenCalled();
  });
});

describe("ohlcBarsToCloses — volume", () => {
  it("carries volume when the bar provides it", () => {
    expect(ohlcBarsToCloses([{ time: "2026-06-15", close: 100, volume: 5000 }])).toEqual([
      { date: "2026-06-15", close: 100, volume: 5000 }
    ]);
  });
});

describe("insider / short-volume import builders", () => {
  it("builds insider rows (shares summed, sentiment from signals) from the cached dataset", () => {
    setInternalSetting("webSource:insider:dataset", {
      filings: [
        { symbol: "AAPL", owner: "Jane Director", buyTx: 3, sellTx: 1, buyShares: 12000, sellShares: 2000, filedAt: recentDate(2), accession: "x1" }
      ],
      fetchedAt: new Date().toISOString(),
      recordCount: 1
    });
    const aapl = buildInsiderImport().find((r) => r.ticker === "AAPL");
    expect(aapl).toMatchObject({ ticker: "AAPL", sentiment: 75, buyFilings: 1, sellFilings: 0, buyShares: 12000, sellShares: 2000 });
    expect(aapl?.owners).toContain("Jane Director");
  });

  it("builds short-volume rows from the FINRA dataset", () => {
    setInternalSetting("webSource:finra:dataset", {
      ratios: { NVDA: 48.3 },
      asOf: recentDate(1),
      fetchedAt: new Date().toISOString(),
      recordCount: 1
    });
    expect(buildShortVolumeImport().find((r) => r.ticker === "NVDA")).toMatchObject({ ticker: "NVDA", ratio: 48.3 });
  });
});

describe("runCongressDailyShare — insider + short-volume on the nightly batch", () => {
  it("includes cached insider + short-volume rows in the first POST", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    setInternalSetting("webSource:insider:dataset", {
      filings: [{ symbol: "AAPL", owner: "Jane", buyTx: 2, sellTx: 0, buyShares: 9000, sellShares: 0, filedAt: recentDate(2), accession: "y1" }],
      fetchedAt: new Date().toISOString(),
      recordCount: 1
    });
    setInternalSetting("webSource:finra:dataset", { ratios: { AAPL: 51.2 }, asOf: recentDate(1), fetchedAt: new Date().toISOString(), recordCount: 1 });
    mockedFetchDailyOHLC.mockResolvedValue([{ time: recentDate(2), close: 1 }, { time: recentDate(1), close: 2 }]);
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await runCongressDailyShare({ now: Date.now(), force: true }); // non-custom → builds both
    expect(res.insiderRows).toBeGreaterThanOrEqual(1);
    expect(res.shortVolRows).toBeGreaterThanOrEqual(1);
    const firstBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(firstBody.insider.length).toBeGreaterThanOrEqual(1);
    expect(firstBody.shortVolume.length).toBeGreaterThanOrEqual(1);
  });
});
