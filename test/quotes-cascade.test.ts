// @ts-nocheck
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFreshQuotesCascade } from "../src/lib/quotes-cascade";
import type { BrokerQuote } from "../src/lib/types";

// Mock the modules that interface with external networks or DB
const mockGetPolicy = vi.fn();
const mockResolveAlpacaMarketData = vi.fn();
vi.mock("../src/lib/db", () => ({
  getPolicy: () => mockGetPolicy(),
  resolveAlpacaMarketData: () => mockResolveAlpacaMarketData(),
}));

const mockGetEquityQuotes = vi.fn();
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getEquityQuotes: mockGetEquityQuotes,
  }),
}));

const mockEnrich = vi.fn();
vi.mock("../src/lib/data-providers", () => ({
  AlpacaSnapshotEnrichmentProvider: class {
    enrich(symbols: string[]) {
      return mockEnrich(symbols);
    }
  },
}));

const mockFetchYahooFinanceQuote = vi.fn();
const mockFetchYahooFinanceQuotesBatch = vi.fn();
vi.mock("../src/lib/yahoo-finance", () => ({
  fetchYahooFinanceQuote: (sym: string) => mockFetchYahooFinanceQuote(sym),
  fetchYahooFinanceQuotesBatch: (syms: string[]) => mockFetchYahooFinanceQuotesBatch(syms),
}));

describe("fetchFreshQuotesCascade", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default configs to bypass early rejects
    mockGetPolicy.mockReturnValue({
      activeBroker: "alpaca",
      accountNumber: "ACC123",
    });
    mockResolveAlpacaMarketData.mockReturnValue({
      apiKey: "fake_key",
      secretKey: "fake_secret",
      source: "env",
    });
  });

  it("resolves fresh quotes immediately at Level 1 (Broker) and stops cascade", async () => {
    const now = Date.now();
    const freshIso = new Date(now - 60 * 1000).toISOString(); // 1 minute old

    const brokerQuotes: Record<string, BrokerQuote> = {
      AAPL: { symbol: "AAPL", price: 150, bid: 149.9, ask: 150.1, asOf: freshIso, provider: "alpaca" },
    };
    mockGetEquityQuotes.mockResolvedValue(brokerQuotes);

    const result = await fetchFreshQuotesCascade(["AAPL"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("ACC123", ["AAPL"]);
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuote).not.toHaveBeenCalled();

    expect(result.AAPL).toEqual(brokerQuotes.AAPL);
  });

  it("falls back to Level 2 (Alpaca Snapshot) if Level 1 returns a stale or missing quote", async () => {
    const now = Date.now();
    const staleIso = new Date(now - 20 * 60 * 1000).toISOString(); // 20 minutes old (stale)
    const freshIso = new Date(now - 5 * 60 * 1000).toISOString(); // 5 minutes old (fresh)

    // Level 1: returns stale quote for MSFT
    mockGetEquityQuotes.mockResolvedValue({
      MSFT: { symbol: "MSFT", price: 300, asOf: staleIso, provider: "alpaca" },
    });

    // Level 2: returns fresh quote
    mockEnrich.mockResolvedValue({
      MSFT: { price: 305, asOf: freshIso, bid: 304, ask: 306, volume: 1000 },
    });

    const result = await fetchFreshQuotesCascade(["MSFT"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("ACC123", ["MSFT"]);
    expect(mockEnrich).toHaveBeenCalledWith(["MSFT"]);
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();

    expect(result.MSFT.price).toBe(305);
    expect(result.MSFT.provider).toBe("alpaca-snapshot");
    expect(result.MSFT.asOf).toBe(freshIso);
  });

  it("cascades through all levels and falls back to the best available quote when all are stale", async () => {
    const now = Date.now();
    const staleBrokerTime = new Date(now - 30 * 60 * 1000).toISOString(); // 30 mins
    const staleAlpacaTime = new Date(now - 25 * 60 * 1000).toISOString(); // 25 mins
    const staleYahooBatchTime = new Date(now - 20 * 60 * 1000).toISOString(); // 20 mins
    const staleYahooSingleTime = new Date(now - 17 * 60 * 1000).toISOString(); // 17 mins

    // All levels return stale quotes for TSLA
    mockGetEquityQuotes.mockResolvedValue({
      TSLA: { symbol: "TSLA", price: 200, asOf: staleBrokerTime, provider: "alpaca" },
    });
    mockEnrich.mockResolvedValue({
      TSLA: { price: 201, asOf: staleAlpacaTime },
    });
    mockFetchYahooFinanceQuotesBatch.mockResolvedValue(
      new Map([["TSLA", { price: 202, asOf: staleYahooBatchTime }]])
    );
    mockFetchYahooFinanceQuote.mockResolvedValue({
      price: 203,
      asOf: staleYahooSingleTime,
    });

    const result = await fetchFreshQuotesCascade(["TSLA"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuote).toHaveBeenCalled();

    // StaleYahooSingleTime (17 mins ago) is the freshest among all stale options.
    expect(result.TSLA.price).toBe(203);
    expect(result.TSLA.provider).toBe("yahoo-finance-single");
    expect(result.TSLA.asOf).toBe(staleYahooSingleTime);
  });
});
