import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/data-providers", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/data-providers")>();
  return { ...actual, getEnrichmentProvider: vi.fn() };
});
vi.mock("@/lib/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: vi.fn(() => null) };
});
vi.mock("@/lib/yahoo-finance", () => ({
  fetchYahooFinanceQuote: vi.fn(),
  fetchYahooFinanceQuoteDetails: vi.fn()
}));
vi.mock("@/lib/on-demand-quote", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/on-demand-quote")>();
  return {
    ...actual,
    loadDurableQuoteSeed: vi.fn(async () => ({})),
    persistOnDemandQuote: vi.fn()
  };
});

import { getEnrichmentProvider } from "@/lib/data-providers";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchYahooFinanceQuote, fetchYahooFinanceQuoteDetails } from "@/lib/yahoo-finance";
import { loadDurableQuoteSeed, persistOnDemandQuote } from "@/lib/on-demand-quote";
import { resetQuoteSingleFlightForTests } from "../src/lib/quote-singleflight";

describe("/api/quote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetQuoteSingleFlightForTests();
    vi.mocked(enforceRateLimit).mockReturnValue(null);
    vi.mocked(fetchYahooFinanceQuote).mockResolvedValue({
      companyName: "Lam Research Corporation",
      price: 77.5,
      bid: 77.42,
      ask: 77.58,
      prevClose: 76,
      volume: 2_500_000,
      asOf: "2026-07-15T15:00:00.000Z",
      syntheticBid: true,
      syntheticAsk: true,
      syntheticSpread: true
    });
    vi.mocked(fetchYahooFinanceQuoteDetails).mockResolvedValue(undefined);
    vi.mocked(loadDurableQuoteSeed).mockResolvedValue({});
  });

  afterEach(() => vi.useRealTimers());

  it("returns the single-symbol enrichment record merged with the symbol", async () => {
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn().mockResolvedValue({
        LRCX: {
          price: 78.2,
          peRatio: 24.1,
          sector: "Technology",
          bid: undefined,
          volume: undefined,
          sources: { price: "alpaca", peRatio: "fmp" }
        }
      })
    });
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=lrcx"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.symbol).toBe("LRCX");
    expect(body.price).toBe(77.5);
    expect(body.peRatio).toBe(24.1);
    expect(body.companyName).toBe("Lam Research Corporation");
    expect(body.volume).toBe(2_500_000);
    expect(body.intradayChangePct).toBe(1.97);
    expect(body.bid).toBeUndefined();
    expect(body.ask).toBeUndefined();
    expect(body.sources).toMatchObject({
      companyName: "yahoo-finance",
      price: "yahoo-finance",
      peRatio: "fmp"
    });
    expect(persistOnDemandQuote).toHaveBeenCalledWith(
      "LRCX",
      expect.objectContaining({ price: 77.5, peRatio: 24.1 })
    );
  });

  it("surfaces durable PE/EPS/52w when the cascade times out and Yahoo details are empty", async () => {
    vi.useFakeTimers();
    const enrich = vi.fn(() => new Promise<Record<string, never>>(() => undefined));
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "slow-test",
      configured: true,
      enrich
    });
    vi.mocked(loadDurableQuoteSeed).mockResolvedValue({
      peRatio: 26.4,
      eps: 8.12,
      fiftyTwoWeekHigh: 208.7,
      fiftyTwoWeekLow: 142.66,
      sources: { peRatio: "yahoo-finance", eps: "yahoo-finance" }
    });
    const { GET } = await import("../app/api/quote/route");

    const pending = GET(new Request("http://localhost/api/quote?symbol=GOOG"));
    await vi.advanceTimersByTimeAsync(6_000);
    const response = await pending;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      symbol: "GOOG",
      price: 77.5,
      volume: 2_500_000,
      peRatio: 26.4,
      eps: 8.12,
      fiftyTwoWeekHigh: 208.7,
      fiftyTwoWeekLow: 142.66
    });
  });

  it("uses keyless Yahoo v7 details for PE/EPS/52w when the store and cascade are empty", async () => {
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn().mockResolvedValue({ LRCX: {} })
    });
    vi.mocked(fetchYahooFinanceQuoteDetails).mockResolvedValue({
      companyName: "Lam Research Corporation",
      price: 77.5,
      bid: 77.42,
      ask: 77.58,
      prevClose: 76,
      volume: 2_500_000,
      asOf: "2026-07-15T15:00:00.000Z",
      peRatio: 29.1,
      eps: 2.66,
      dividendYield: 0.89,
      beta: 1.45,
      fiftyTwoWeekHigh: 113.0,
      fiftyTwoWeekLow: 56.32,
      syntheticBid: false,
      syntheticAsk: false
    });
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      peRatio: 29.1,
      eps: 2.66,
      dividendYield: 0.89,
      beta: 1.45,
      fiftyTwoWeekHigh: 113.0,
      fiftyTwoWeekLow: 56.32
    });
  });

  it("returns the fast company identity and current quote when the rich cascade exceeds its budget", async () => {
    vi.useFakeTimers();
    const enrich = vi.fn(() => new Promise<Record<string, never>>(() => undefined));
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "slow-test",
      configured: true,
      enrich
    });
    const { GET } = await import("../app/api/quote/route");

    const pending = GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    await vi.advanceTimersByTimeAsync(6_000);
    const response = await pending;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      symbol: "LRCX",
      companyName: "Lam Research Corporation",
      price: 77.5,
      volume: 2_500_000
    });
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it("accepts a richer current quote when its timestamp is newer than the fast floor", async () => {
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn().mockResolvedValue({
        LRCX: {
          price: 78.2,
          volume: 2_700_000,
          intradayChangePct: 2.9,
          asOf: "2026-07-15T15:01:00.000Z",
          sources: {
            price: "alpaca",
            volume: "alpaca",
            intradayChangePct: "alpaca",
            asOf: "alpaca"
          }
        }
      })
    });
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      price: 78.2,
      volume: 2_700_000,
      intradayChangePct: 2.9,
      asOf: "2026-07-15T15:01:00.000Z"
    });
    expect(body.sources).toMatchObject({
      price: "alpaca",
      volume: "alpaca",
      intradayChangePct: "alpaca",
      asOf: "alpaca"
    });
  });

  it("coalesces a still-running rich cascade across repeated opens", async () => {
    vi.useFakeTimers();
    const enrich = vi.fn(() => new Promise<Record<string, never>>(() => undefined));
    vi.mocked(getEnrichmentProvider).mockReturnValue({ name: "slow-test", configured: true, enrich });
    const { GET } = await import("../app/api/quote/route");

    const first = GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    const second = GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it("evicts a permanently hung rich cascade after its bounded single-flight lease", async () => {
    vi.useFakeTimers();
    const enrich = vi.fn(() => new Promise<Record<string, never>>(() => undefined));
    vi.mocked(getEnrichmentProvider).mockReturnValue({ name: "slow-test", configured: true, enrich });
    const { GET } = await import("../app/api/quote/route");

    const first = GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(first).resolves.toMatchObject({ status: 200 });

    await vi.advanceTimersByTimeAsync(24_000);
    const second = GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(enrich).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid or missing symbol without calling the provider", async () => {
    const enrich = vi.fn();
    vi.mocked(getEnrichmentProvider).mockReturnValue({ name: "test", configured: true, enrich });
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=" + encodeURIComponent("bad symbol!")));
    expect(response.status).toBe(400);
    expect(enrich).not.toHaveBeenCalled();
    expect(fetchYahooFinanceQuote).not.toHaveBeenCalled();
    expect(fetchYahooFinanceQuoteDetails).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(enforceRateLimit).mockReturnValue(new Response(JSON.stringify({ ok: false }), { status: 429 }));
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    expect(response.status).toBe(429);
  });

  it("degrades to a 502 with the symbol echoed back when the provider throws", async () => {
    vi.mocked(fetchYahooFinanceQuote).mockResolvedValue(undefined);
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn().mockRejectedValue(new Error("upstream down"))
    });
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body.symbol).toBe("LRCX");
  });
});
