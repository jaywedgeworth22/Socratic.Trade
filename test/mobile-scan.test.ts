import { describe, expect, it } from "vitest";
import { compactMobileMarketScan } from "../src/lib/mobile-scan";
import type { MarketQuote, MarketScan } from "../src/lib/types";

function quote(partial: Pick<MarketQuote, "symbol"> & Partial<MarketQuote>): MarketQuote {
  return {
    symbol: partial.symbol,
    companyName: partial.companyName ?? partial.symbol,
    price: partial.price ?? 100,
    score: partial.score ?? 50,
    ...partial
  } as MarketQuote;
}

function scan(partial: Partial<MarketScan> & Pick<MarketScan, "generatedAt" | "topCandidates">): MarketScan {
  return {
    source: "nasdaq-delayed-screener+yahoo-finance",
    scannedSymbols: 5073,
    returnedQuotes: 5069,
    sectorBySymbol: {},
    quotesBySymbol: { AAPL: { symbol: "AAPL", price: 210, score: 80 } },
    warnings: [],
    ...partial
  };
}

describe("compactMobileMarketScan", () => {
  it("keeps ranked names and drops the 5k quotesBySymbol map", () => {
    const compact = compactMobileMarketScan(scan({
      generatedAt: "2026-08-18T19:25:13.000Z",
      candidateLimit: 50,
      heldCandidateCount: 5,
      outlierCandidateCount: 15,
      warnings: ["Coverage is thin on a few names."],
      dataCoverage: {
        symbolCount: 70,
        fieldFillRates: { peRatio: 0.4 },
        missingFields: [],
        partialFields: ["peRatio"],
        shortfallSummary: "Some ranked names are missing P/E.",
        contributingSources: ["yahoo-finance"],
        durableStoreSeededCount: 10,
        topGaps: []
      },
      topCandidates: [
        quote({ symbol: "BRK-B", companyName: "Berkshire Hathaway", price: 500, score: 88 }),
        quote({ symbol: "GOOG", price: 180, score: 86 })
      ]
    }));

    expect(compact).toMatchObject({
      generatedAt: "2026-08-18T19:25:13.000Z",
      asOf: "2026-08-18T19:25:13.000Z",
      scannedSymbols: 5073,
      returnedQuotes: 5069,
      source: "nasdaq-delayed-screener+yahoo-finance"
    });
    expect(compact?.topCandidates.map((row) => row.symbol)).toEqual(["BRK-B", "GOOG"]);
    expect(compact?.warnings).toContain("Coverage is thin on a few names.");
    expect(compact?.warnings).toContain("Some ranked names are missing P/E.");
    expect(compact).not.toHaveProperty("quotesBySymbol");
  });

  it("drops a 505/0/0 abort so it cannot become last-good", () => {
    expect(compactMobileMarketScan(scan({
      generatedAt: "2026-08-18T22:00:00.000Z",
      scannedSymbols: 505,
      returnedQuotes: 0,
      topCandidates: []
    }))).toBeNull();
  });

  it("returns null for a missing or shapeless scan", () => {
    expect(compactMobileMarketScan(null)).toBeNull();
    expect(compactMobileMarketScan(undefined)).toBeNull();
    expect(compactMobileMarketScan({ topCandidates: [] } as MarketScan)).toBeNull();
  });
});
