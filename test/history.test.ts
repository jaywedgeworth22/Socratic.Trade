import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearHistoryCache, fetchDailyOHLC, parseStooqCsv, toBusinessDay } from "../src/lib/history";

beforeEach(() => clearHistoryCache());
afterEach(() => vi.unstubAllGlobals());

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
  const yahooBody = (n: number) => {
    const timestamp = Array.from({ length: n }, (_, i) => Math.floor(Date.UTC(2025, 0, 1) / 1000) + i * 86_400);
    const arr = (base: number) => Array.from({ length: n }, (_, i) => base + i);
    const quote = [{ open: arr(100), high: arr(101), low: arr(99), close: arr(100), volume: arr(1000) }];
    return JSON.stringify({ chart: { result: [{ timestamp, indicators: { quote } }] } });
  };

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

  it("falls back to Stooq when Yahoo yields nothing", async () => {
    const stooq = `Date,Open,High,Low,Close,Volume\n2026-06-16,10,11,9,10.5,1000\n2026-06-17,10.5,12,10,11.8,2000`;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("query1.finance.yahoo.com")) return new Response(JSON.stringify({ chart: { result: [{}] } }), { status: 200 });
      if (String(url).includes("stooq.com")) return new Response(stooq, { status: 200 });
      return new Response("nope", { status: 404 });
    });
    const bars = await fetchDailyOHLC("BBB");
    expect(bars).not.toBeNull();
    expect(bars!.length).toBe(2);
  });

  it("returns null when no source has data (never fabricates)", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    expect(await fetchDailyOHLC("ZZZ")).toBeNull();
  });
});
