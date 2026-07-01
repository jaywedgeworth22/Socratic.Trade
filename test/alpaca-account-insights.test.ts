import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAlpacaAccountActivities,
  fetchAlpacaMarketCalendar,
  fetchAlpacaMarketClock,
  fetchAlpacaPortfolioHistory,
} from "../src/lib/alpaca-account-insights";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-insights-${randomUUID()}.db`)}`;
});

const originalKey = process.env.ALPACA_PAPER_API_KEY;
const originalSecret = process.env.ALPACA_PAPER_SECRET_KEY;
const originalBase = process.env.ALPACA_TRADING_BASE_URL;

describe("alpaca-account-insights", () => {
  beforeEach(() => {
    process.env.ALPACA_PAPER_API_KEY = "key-id";
    process.env.ALPACA_PAPER_SECRET_KEY = "key-secret";
    delete process.env.ALPACA_TRADING_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.ALPACA_PAPER_API_KEY;
    else process.env.ALPACA_PAPER_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.ALPACA_PAPER_SECRET_KEY;
    else process.env.ALPACA_PAPER_SECRET_KEY = originalSecret;
    if (originalBase === undefined) delete process.env.ALPACA_TRADING_BASE_URL;
    else process.env.ALPACA_TRADING_BASE_URL = originalBase;
  });

  describe("fetchAlpacaPortfolioHistory", () => {
    it("hits the trading portfolio-history endpoint with auth headers and maps the equity curve", async () => {
      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            timestamp: [1_700_000_000, 1_700_086_400],
            equity: [100_000, 101_250],
            profit_loss: [0, 1_250],
            profit_loss_pct: [0, 0.0125],
            base_value: 100_000,
            timeframe: "1D",
          })
        );
      });

      const result = await fetchAlpacaPortfolioHistory("u1", { period: "1M", timeframe: "1D" });

      expect(capturedUrl).toContain("paper-api.alpaca.markets");
      expect(capturedUrl).toContain("/v2/account/portfolio/history");
      expect(capturedUrl).toContain("period=1M");
      expect(capturedUrl).toContain("timeframe=1D");
      expect(capturedHeaders["APCA-API-KEY-ID"]).toBe("key-id");
      expect(capturedHeaders["APCA-API-SECRET-KEY"]).toBe("key-secret");
      expect(result?.equity).toEqual([100_000, 101_250]);
      expect(result?.profit_loss_pct).toEqual([0, 0.0125]);
      expect(result?.timeframe).toBe("1D");
    });

    it("returns undefined when no Alpaca credential is available", async () => {
      delete process.env.ALPACA_PAPER_API_KEY;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const result = await fetchAlpacaPortfolioHistory("u1");
      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns undefined on an HTTP error", async () => {
      vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));
      const result = await fetchAlpacaPortfolioHistory("u1");
      expect(result).toBeUndefined();
    });
  });

  describe("fetchAlpacaMarketCalendar", () => {
    it("hits the calendar endpoint with start/end and maps session info", async () => {
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify([
            {
              date: "2026-06-30",
              open: "09:30",
              close: "16:00",
              session_open: "0400",
              session_close: "2000",
            },
          ])
        );
      });

      const days = await fetchAlpacaMarketCalendar({ start: "2026-06-01", end: "2026-06-30" });

      expect(capturedUrl).toContain("/v2/calendar");
      expect(capturedUrl).toContain("start=2026-06-01");
      expect(capturedUrl).toContain("end=2026-06-30");
      expect(days).toHaveLength(1);
      expect(days[0].date).toBe("2026-06-30");
      expect(days[0].open).toBe("09:30");
      expect(days[0].close).toBe("16:00");
    });

    it("returns an empty array when no Alpaca credential is available", async () => {
      delete process.env.ALPACA_PAPER_API_KEY;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const days = await fetchAlpacaMarketCalendar();
      expect(days).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns an empty array on a network failure", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("network down");
      });
      const days = await fetchAlpacaMarketCalendar();
      expect(days).toEqual([]);
    });
  });

  describe("fetchAlpacaMarketClock", () => {
    it("hits the clock endpoint and maps the open state + next open/close", async () => {
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify({
            timestamp: "2026-06-30T14:00:00-04:00",
            is_open: true,
            next_open: "2026-07-01T09:30:00-04:00",
            next_close: "2026-06-30T16:00:00-04:00",
          })
        );
      });

      const clock = await fetchAlpacaMarketClock();

      expect(capturedUrl).toContain("/v2/clock");
      expect(clock?.is_open).toBe(true);
      expect(clock?.next_open).toBe("2026-07-01T09:30:00-04:00");
      expect(clock?.next_close).toBe("2026-06-30T16:00:00-04:00");
    });

    it("returns undefined when no Alpaca credential is available", async () => {
      delete process.env.ALPACA_PAPER_API_KEY;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const clock = await fetchAlpacaMarketClock();
      expect(clock).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("fetchAlpacaAccountActivities", () => {
    it("hits the activities endpoint with an activity_types filter and maps fill + non-trade rows", async () => {
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(
          JSON.stringify([
            {
              id: "abc",
              activity_type: "FILL",
              transaction_time: "2026-06-30T14:00:00Z",
              type: "fill",
              price: "195.50",
              qty: "10",
              side: "buy",
              symbol: "AAPL",
              leaves_qty: "0",
              cum_qty: "10",
              order_id: "ord-1",
              order_status: "filled",
            },
            {
              id: "div",
              activity_type: "DIV",
              date: "2026-06-30",
              net_amount: "12.34",
              symbol: "MSFT",
              per_share_amount: "0.75",
              status: "executed",
            },
          ])
        );
      });

      const activities = await fetchAlpacaAccountActivities("u1", { activityTypes: ["FILL", "DIV"] });

      expect(capturedUrl).toContain("/v2/account/activities");
      expect(capturedUrl).toContain("activity_types=FILL%2CDIV");
      expect(activities).toHaveLength(2);
      expect(activities[0].symbol).toBe("AAPL");
      expect(activities[0].side).toBe("buy");
      expect(activities[1].activity_type).toBe("DIV");
      expect(activities[1].net_amount).toBe("12.34");
    });

    it("omits the activity_types param when none are supplied", async () => {
      let capturedUrl = "";
      vi.stubGlobal("fetch", async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]));
      });

      await fetchAlpacaAccountActivities("u1");
      expect(capturedUrl).toContain("/v2/account/activities");
      expect(capturedUrl).not.toContain("activity_types");
    });

    it("returns an empty array when no Alpaca credential is available", async () => {
      delete process.env.ALPACA_PAPER_API_KEY;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const activities = await fetchAlpacaAccountActivities("u1");
      expect(activities).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("honors ALPACA_TRADING_BASE_URL for the live host", async () => {
    process.env.ALPACA_TRADING_BASE_URL = "https://api.alpaca.markets/";
    let capturedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ timestamp: "t", is_open: false, next_open: "n", next_close: "c" }));
    });

    await fetchAlpacaMarketClock();
    expect(capturedUrl).toBe("https://api.alpaca.markets/v2/clock");
  });
});
