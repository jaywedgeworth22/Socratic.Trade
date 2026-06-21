import { describe, expect, it } from "vitest";
import { deterministicBearFilter } from "../src/lib/strategy";
import type { EquityPosition, MarketFactorBreakdown, MarketQuote, TradeProposal } from "../src/lib/types";

function makeProposal(overrides: Partial<TradeProposal>): TradeProposal {
  return {
    symbol: "AAPL",
    side: "buy",
    type: "market",
    quantity: null,
    dollarAmount: 1000,
    limitPrice: null,
    stopPrice: null,
    timeInForce: "day",
    marketHours: "regular",
    rationale: "Test rationale",
    tradeThesisTag: "momentum_breakout",
    entryMarketRegime: "Neutral (Normal Volatility)",
    confidenceScore: 60,
    ...overrides
  };
}

function makeQuote(symbol: string, score: number, momentum = 50, value = 50): MarketQuote {
  const factorBreakdown = {
    liquidity: 50, momentum, value, quality: 50, volatility: 50,
    sentiment: 50, positioning: 50, diversification: 50, weightedTotal: score
  } as unknown as MarketFactorBreakdown;
  return {
    symbol, score, factorBreakdown,
    price: 100, change: 0, changePercent: 0, volume: 1_000_000,
    marketCap: 1e12, peRatio: null, eps: null, high52w: 110, low52w: 80, cached: false
  } as unknown as MarketQuote;
}

function makePosition(symbol: string): EquityPosition {
  return { symbol, quantity: 10, averageCost: 90, marketValue: 1000 };
}

describe("deterministicBearFilter", () => {
  describe("Rule 1: no-position-to-exit veto", () => {
    it("vetoes a sell when there is no matching long position", () => {
      const proposal = makeProposal({ symbol: "NVDA", side: "sell" });
      const { kept, vetoed } = deterministicBearFilter([proposal], [], [], "Neutral (Normal Volatility)");
      expect(kept).toHaveLength(0);
      expect(vetoed).toHaveLength(1);
      expect(vetoed[0].reason).toContain("No existing long position");
    });

    it("allows a sell when a matching long position exists", () => {
      const proposal = makeProposal({ symbol: "NVDA", side: "sell" });
      const position = makePosition("NVDA");
      const { kept, vetoed } = deterministicBearFilter([proposal], [position], [], "Neutral (Normal Volatility)");
      expect(kept).toHaveLength(1);
      expect(vetoed).toHaveLength(0);
    });

    it("normalizes symbol case when matching positions", () => {
      const proposal = makeProposal({ symbol: "nvda", side: "sell" });
      const position = makePosition("NVDA");
      const { kept } = deterministicBearFilter([proposal], [position], [], "Neutral (Normal Volatility)");
      expect(kept).toHaveLength(1);
    });

    it("does not veto a buy regardless of position state", () => {
      const proposal = makeProposal({ symbol: "NVDA", side: "buy" });
      const { kept } = deterministicBearFilter([proposal], [], [], "Neutral (Normal Volatility)");
      expect(kept).toHaveLength(1);
    });
  });

  describe("Rule 2: momentum overextension flag", () => {
    it("prepends a flag to the rationale when momentum > 92 and value < 20", () => {
      const quote = makeQuote("TSLA", 80, 95, 10); // extreme momentum, low value
      const proposal = makeProposal({ symbol: "TSLA" });
      const { kept } = deterministicBearFilter([proposal], [], [quote], "Neutral (Normal Volatility)");
      expect(kept).toHaveLength(1); // not a hard veto
      expect(kept[0].rationale).toMatch(/Deterministic flag.*momentum overextension/);
    });

    it("does not flag when momentum is high but value is also adequate", () => {
      const quote = makeQuote("TSLA", 80, 95, 30); // high momentum but not value-poor
      const proposal = makeProposal({ symbol: "TSLA" });
      const { kept } = deterministicBearFilter([proposal], [], [quote], "Neutral (Normal Volatility)");
      expect(kept[0].rationale).not.toMatch(/Deterministic flag/);
    });

    it("does not flag a sell even with extreme factor scores", () => {
      const quote = makeQuote("TSLA", 80, 95, 10);
      const proposal = makeProposal({ symbol: "TSLA", side: "sell" });
      const position = makePosition("TSLA");
      const { kept } = deterministicBearFilter([proposal], [position], [quote], "Neutral (Normal Volatility)");
      expect(kept[0].rationale).not.toMatch(/Deterministic flag/);
    });
  });

  describe("Rule 3: regime contradiction veto", () => {
    it("vetoes a below-median buy in Crisis regime", () => {
      const quotes = [
        makeQuote("AAPL", 80),
        makeQuote("NVDA", 70),
        makeQuote("META", 40) // below median of 70
      ];
      const proposal = makeProposal({ symbol: "META" });
      const { kept, vetoed } = deterministicBearFilter(
        [proposal], [], quotes, "Crisis (Extreme Volatility)"
      );
      expect(kept).toHaveLength(0);
      expect(vetoed[0].reason).toContain("Crisis");
    });

    it("vetoes a below-median buy in Risk-Off regime", () => {
      const quotes = [makeQuote("AAPL", 80), makeQuote("META", 30)];
      const proposal = makeProposal({ symbol: "META" });
      const { kept } = deterministicBearFilter([proposal], [], quotes, "Risk-Off (High Volatility)");
      expect(kept).toHaveLength(0);
    });

    it("allows an above-median buy even in Crisis regime", () => {
      const quotes = [makeQuote("AAPL", 80), makeQuote("META", 90)];
      const proposal = makeProposal({ symbol: "META" });
      const { kept } = deterministicBearFilter([proposal], [], quotes, "Crisis (Extreme Volatility)");
      expect(kept).toHaveLength(1);
    });

    it("does not apply the regime rule in Neutral regime", () => {
      const quotes = [makeQuote("AAPL", 80), makeQuote("META", 20)];
      const proposal = makeProposal({ symbol: "META" });
      const { kept } = deterministicBearFilter([proposal], [], quotes, "Neutral (Normal Volatility)");
      expect(kept).toHaveLength(1); // neutral regime — rule 3 doesn't fire
    });

    it("does not apply regime rule to sell proposals", () => {
      const quotes = [makeQuote("AAPL", 80), makeQuote("META", 20)];
      const proposal = makeProposal({ symbol: "META", side: "sell" });
      const position = makePosition("META");
      const { kept } = deterministicBearFilter([proposal], [position], quotes, "Crisis (Extreme Volatility)");
      expect(kept).toHaveLength(1);
    });
  });

  describe("multiple proposals and mixed rules", () => {
    it("keeps unaffected proposals when one is vetoed", () => {
      const quotes = [makeQuote("AAPL", 90), makeQuote("WEAK", 20)];
      const proposals = [
        makeProposal({ symbol: "AAPL" }),
        makeProposal({ symbol: "WEAK" }) // below median in crisis
      ];
      const { kept, vetoed } = deterministicBearFilter(
        proposals, [], quotes, "Crisis (Extreme Volatility)"
      );
      expect(kept).toHaveLength(1);
      expect(kept[0].symbol).toBe("AAPL");
      expect(vetoed).toHaveLength(1);
    });

    it("returns empty kept and empty vetoed for empty input", () => {
      const { kept, vetoed } = deterministicBearFilter([], [], [], "Neutral (Normal Volatility)");
      expect(kept).toHaveLength(0);
      expect(vetoed).toHaveLength(0);
    });
  });
});
