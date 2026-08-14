import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/data-providers", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/data-providers")>();
  return { ...actual, getEnrichmentProvider: vi.fn(), enrichYahooFinanceSymbol: vi.fn() };
});
vi.mock("@/lib/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: vi.fn(() => null) };
});
vi.mock("@/lib/yahoo-finance", () => ({ fetchYahooFinanceQuote: vi.fn() }));
vi.mock("@/lib/on-demand-quote", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/on-demand-quote")>();
  return {
    ...actual,
    loadDurableQuoteSeed: vi.fn(async () => ({})),
    persistOnDemandQuote: vi.fn()
  };
});

import { enrichYahooFinanceSymbol, getEnrichmentProvider } from "@/lib/data-providers";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchYahooFinanceQuote } from "@/lib/yahoo-finance";
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
    vi.mocked(enrichYahooFinanceSymbol).mockResolvedValue({});
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

  it("keeps chart 52-week range when the rich cascade exceeds its budget", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchYahooFinanceQuote).mockResolvedValue({
      companyName: "Alphabet Inc.",
      price: 343.94,
      bid: 343.6,
      ask: 344.3,
      prevClose: 342.37,
      volume: 14_897_228,
      asOf: "2026-08-13T20:00:00.000Z",
      fiftyTwoWeekHigh: 404.47,
      fiftyTwoWeekLow: 197.46,
      syntheticBid: true,
      syntheticAsk: true,
      syntheticSpread: true
    });
    const enrich = vi.fn(() => new Promise<Record<string, never>>(() => undefined));
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "slow-test",
      configured: true,
      enrich
    });
    const { GET } = await import("../app/api/quote/route");

    const pending = GET(new Request("http://localhost/api/quote?symbol=GOOG"));
    await vi.advanceTimersByTimeAsync(6_000);
    const response = await pending;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      symbol: "GOOG",
      companyName: "Alphabet Inc.",
      price: 343.94,
      fiftyTwoWeekHigh: 404.47,
      fiftyTwoWeekLow: 197.46
    });
    expect(persistOnDemandQuote).toHaveBeenCalled();
  });

  it("returns Yahoo quoteSummary PE/EPS when the full cascade times out", async () => {
    vi.useFakeTimers();
    vi.mocked(enrichYahooFinanceSymbol).mockResolvedValue({
      peRatio: 26.4,
      eps: 10.12,
      dividendYield: 0.32,
      beta: 1.01,
      sources: {
        peRatio: "yahoo-finance",
        eps: "yahoo-finance",
        dividendYield: "yahoo-finance",
        beta: "yahoo-finance"
      }
    });
    const enrich = vi.fn(() => new Promise<Record<string, never>>(() => undefined));
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "slow-test",
      configured: true,
      enrich
    });
    const { GET } = await import("../app/api/quote/route");

    const pending = GET(new Request("http://localhost/api/quote?symbol=GOOG"));
    await vi.advanceTimersByTimeAsync(6_000);
    const body = await (await pending).json();

    expect(body).toMatchObject({
      symbol: "GOOG",
      price: 77.5,
      peRatio: 26.4,
      eps: 10.12,
      dividendYield: 0.32,
      beta: 1.01
    });
  });

  it("seeds durable PE when live layers omit it and still writes the merged quote back", async () => {
    vi.mocked(loadDurableQuoteSeed).mockResolvedValue({
      peRatio: 26.4,
      eps: 8.12,
      sources: { peRatio: "symbol-field-latest", eps: "symbol-field-latest" }
    });
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn().mockResolvedValue({ LRCX: {} })
    });
    const { GET } = await import("../app/api/quote/route");

    const body = await (await GET(new Request("http://localhost/api/quote?symbol=LRCX"))).json();
    expect(body).toMatchObject({
      symbol: "LRCX",
      price: 77.5,
      peRatio: 26.4,
      eps: 8.12
    });
    expect(persistOnDemandQuote).toHaveBeenCalled();
  });
});
