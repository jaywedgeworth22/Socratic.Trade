import { describe, expect, it } from "vitest";
import { applyEnrichment, rankMarketQuotes, scoreFactors } from "../src/lib/market";
import type { SymbolEnrichment } from "../src/lib/data-providers";
import type { MarketQuote } from "../src/lib/types";

describe("rankMarketQuotes", () => {
  it("prioritizes liquid positive movers without existing exposure", () => {
    const quotes: MarketQuote[] = [
      quote({ symbol: "AAPL", volume: 5_000_000, intradayChangePct: 1, positionMarketValue: 20 }),
      quote({ symbol: "MSFT", volume: 20_000_000, intradayChangePct: 2, positionMarketValue: 0 }),
      quote({ symbol: "XYZ", volume: 10_000, intradayChangePct: -3, positionMarketValue: 0 })
    ];

    expect(rankMarketQuotes(quotes).map((item) => item.symbol)).toEqual(["MSFT", "AAPL", "XYZ"]);
  });

  it("normalizes scoring weights into a transparent factor total", () => {
    const scored = scoreFactors(
      quote({ symbol: "MSFT", volume: 20_000_000, intradayChangePct: 2, positionMarketValue: 0 }),
      { liquidity: 1, momentum: 1, value: 0, quality: 0, volatility: 0, sentiment: 0, diversification: 0 }
    );

    expect(scored.liquidity).toBeGreaterThan(0);
    expect(scored.momentum).toBeGreaterThan(50);
    expect(scored.weightedTotal).toBeGreaterThan(40);
    expect(scored.weightedTotal).toBeLessThanOrEqual(100);
  });

  it("rewards strong fundamentals in the value and quality sub-scores", () => {
    const common = { marketCap: 2_000_000_000, volume: 2_000_000, peRatio: 30 };
    const weak = scoreFactors(quote({ symbol: "W", ...common, fcfYield: -2, debtToEquity: 350, epsGrowth: -0.2 }));
    const strong = scoreFactors(quote({ symbol: "S", ...common, fcfYield: 8, debtToEquity: 30, epsGrowth: 0.25 }));
    expect(strong.value).toBeGreaterThan(weak.value); // FCF yield lifts value
    expect(strong.quality).toBeGreaterThan(weak.quality); // low leverage + EPS growth lift quality
  });
});

describe("applyEnrichment", () => {
  it("folds every enriched field (incl. fcf/leverage/growth/congress) onto the quote", () => {
    // Regression: these four used to be dropped by the scan merge, so scoring/prompt/UI
    // never saw them even when a provider supplied real values.
    const extra: SymbolEnrichment = {
      fcfYield: 7.5,
      debtToEquity: 0.4,
      epsGrowth: 0.22,
      senateTrades: 3,
      insiderSentiment: 80,
      peRatio: 18,
      sector: "Technology",
      sources: { fcfYield: "yahoo-finance", senateTrades: "congress-trades" }
    };
    const enriched = applyEnrichment(quote({ symbol: "NVDA" }), extra);
    expect(enriched.fcfYield).toBe(7.5);
    expect(enriched.debtToEquity).toBe(0.4);
    expect(enriched.epsGrowth).toBe(0.22);
    expect(enriched.senateTrades).toBe(3);
    expect(enriched.insiderSentiment).toBe(80);
    expect(enriched.sources?.fcfYield).toBe("yahoo-finance");
    expect(enriched.sources?.senateTrades).toBe("congress-trades");
  });

  it("keeps the existing quote value when enrichment omits a field", () => {
    const enriched = applyEnrichment(quote({ symbol: "AAPL", senateTrades: 2 }), { peRatio: 30 });
    expect(enriched.senateTrades).toBe(2); // not clobbered by undefined
    expect(enriched.peRatio).toBe(30);
  });
});

function quote(input: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return {
    price: 100,
    volume: 1,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 0,
    ...input
  };
}
