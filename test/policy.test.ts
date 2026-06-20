import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { allowedSymbolsForPolicy, evaluateTradeProposal } from "../src/lib/policy";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

const portfolio: Portfolio = {
  accountNumber: "A1",
  totalMarketValue: 10000,
  buyingPower: 5000,
  equityMarketValue: 5000,
  optionMarketValue: 0,
  cash: 5000
};

const positions: EquityPosition[] = [{ symbol: "AAPL", quantity: 5, averageCost: 200, marketValue: 1000, sector: "Technology" }];

const enabledPolicy: TradingPolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  paperMode: false,
  strategyAuthority: "decide",
  accountNumber: "A1",
  includedIndices: [],
  additionalSymbols: ["AAPL", "VOO"]
};

const proposal: TradeProposal = {
  symbol: "VOO",
  side: "buy",
  type: "market",
  dollarAmount: 10,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "test",
  entryMarketRegime: "test"
};

describe("evaluateTradeProposal", () => {
  it("approves an in-policy order", () => {
    const decision = evaluateTradeProposal(proposal, {
      policy: enabledPolicy,
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10
    });
    expect(decision.approved).toBe(true);
  });

  it("blocks a buy of a wash-sale-locked symbol when the guard is on", () => {
    const decision = evaluateTradeProposal(proposal, {
      policy: enabledPolicy,
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10,
      washSaleLockedSymbols: new Set(["VOO"])
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("wash-sale"))).toBe(true);
  });

  it("allows a locked-symbol buy when the wash-sale guard is disabled", () => {
    const decision = evaluateTradeProposal(proposal, {
      policy: { ...enabledPolicy, taxSettings: { washSaleGuard: false, shortTermRatePct: 24, longTermRatePct: 15 } },
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10,
      washSaleLockedSymbols: new Set(["VOO"])
    });
    expect(decision.approved).toBe(true);
  });

  it("blocks symbols outside the allowed universe", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "TSLA" }, context());
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not in the allowed universe");
  });

  it("allows S&P 500 symbols when the S&P universe is selected", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, {
      ...context(),
      policy: { ...enabledPolicy, includedIndices: ["sp500"], additionalSymbols: [] },
      estimatedNotional: 10
    });
    expect(decision.approved).toBe(true);
  });

  it("allows Nasdaq 100 and Dow 30 symbols when those universes are selected", () => {
    const nasdaqDecision = evaluateTradeProposal({ ...proposal, symbol: "ASML" }, {
      ...context(),
      policy: { ...enabledPolicy, includedIndices: ["nasdaq100"], additionalSymbols: [] },
      estimatedNotional: 10
    });
    const dowDecision = evaluateTradeProposal({ ...proposal, symbol: "GS" }, {
      ...context(),
      policy: { ...enabledPolicy, includedIndices: ["dow30"], additionalSymbols: [] },
      estimatedNotional: 10
    });

    expect(nasdaqDecision.approved).toBe(true);
    expect(dowDecision.approved).toBe(true);
  });

  it("subtracts the ignore list from selected indexes and additional watchlist symbols", () => {
    const policy: TradingPolicy = { ...enabledPolicy, includedIndices: ["dow30"], additionalSymbols: ["AAPL", "VOO"], blocklist: ["AAPL", "GS"] };
    const allowedSymbols = allowedSymbolsForPolicy(policy);
    const blockedDecision = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, { ...context(), policy, estimatedNotional: 10 });

    expect(allowedSymbols).not.toContain("AAPL");
    expect(allowedSymbols).not.toContain("GS");
    expect(allowedSymbols).toContain("VOO");
    expect(blockedDecision.approved).toBe(false);
    expect(blockedDecision.reasons.join(" ")).toContain("not in the allowed universe");
  });

  it("blocks orders over max notional", () => {
    const decision = evaluateTradeProposal({ ...proposal, dollarAmount: 1200 }, context(1200));
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("exceeds the maximum order limit");
  });

  it("blocks daily notional overflow", () => {
    const decision = evaluateTradeProposal(proposal, {
      ...context(),
      dailyNotionalUsed: 495
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Daily notional");
  });

  it("blocks daily order count overflow", () => {
    const decision = evaluateTradeProposal(proposal, {
      ...context(),
      dailyOrderCount: 10
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Daily order count");
  });

  it("blocks over-concentrated post-trade exposure", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "AAPL", dollarAmount: 2000 }, context(2000));
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Projected AAPL exposure");
  });

  it("blocks sector cap overflow using position metadata", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, {
      ...context(),
      policy: { ...enabledPolicy, sectorCaps: { Technology: 10 } }
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Technology sector exposure");
  });

  it("blocks adding to positions past stop-loss or take-profit rules", () => {
    const stopLoss = evaluateTradeProposal({ ...proposal, symbol: "AAPL", limitPrice: 150 }, {
      ...context(),
      positions: [{ symbol: "AAPL", quantity: 5, averageCost: 250, marketValue: 1000, sector: "Technology" }]
    });
    const takeProfit = evaluateTradeProposal({ ...proposal, symbol: "AAPL", limitPrice: 150 }, {
      ...context(),
      positions: [{ symbol: "AAPL", quantity: 5, averageCost: 100, marketValue: 1500, sector: "Technology" }]
    });
    expect(stopLoss.approved).toBe(false);
    expect(stopLoss.reasons.join(" ")).toContain("Stop-loss");
    expect(takeProfit.approved).toBe(false);
    expect(takeProfit.reasons.join(" ")).toContain("Take-profit");
  });

  it("blocks fractional or dollar-based orders outside regular hours", () => {
    const decision = evaluateTradeProposal({ ...proposal, marketHours: "extended_hours" }, context());
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("regular-hours only");
  });

  it("blocks selling more than held quantity", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 10, dollarAmount: undefined, limitPrice: 200 },
      context(2000)
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("exceeds current AAPL holdings");
  });

  it("allows sell orders to bypass max order notional and daily notional limits", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 1, dollarAmount: undefined, limitPrice: 2000 },
      {
        ...context(2000),
        dailyNotionalUsed: 2000
      }
    );
    expect(decision.approved).toBe(true);
  });

  it("preserves crisis-regime opening buys when no crisis exposure cap is configured", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, entryMarketRegime: "Crisis (Extreme Volatility)", dollarAmount: 1200 },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50
        }
      }
    );
    expect(decision.approved).toBe(true);
  });

  it("blocks opening exposure over the configured cap in crisis or inverted regimes", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, entryMarketRegime: "Cautious (Inverted Curve)", dollarAmount: 1200 },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        }
      }
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("crisis/inverted-regime cap 5%");
  });

  it("does not apply the crisis exposure cap in normal regimes", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, entryMarketRegime: "Neutral (Normal Volatility)", dollarAmount: 1200 },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        }
      }
    );
    expect(decision.approved).toBe(true);
  });

  it("does not block risk-reducing sells or covers with the crisis exposure cap", () => {
    const sell = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 1, dollarAmount: undefined, limitPrice: 1200, entryMarketRegime: "Crisis (Extreme Volatility)" },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        }
      }
    );
    const cover = evaluateTradeProposal(
      { ...proposal, symbol: "TSLA", side: "cover", quantity: 1, dollarAmount: undefined, limitPrice: 1200, entryMarketRegime: "Cautious (Inverted Curve)" },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          additionalSymbols: ["AAPL", "VOO", "TSLA"],
          shortSellingEnabled: true,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        },
        positions: [
          ...positions,
          { symbol: "TSLA", quantity: -2, averageCost: 1000, marketValue: -2000, sector: "Consumer Cyclical" }
        ]
      }
    );
    expect(sell.approved).toBe(true);
    expect(cover.approved).toBe(true);
  });

  it("blocks when system state is halted", () => {
    const decision = evaluateTradeProposal(proposal, {
      ...context(),
      policy: { ...enabledPolicy, systemState: "halted" }
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("halted");
  });

  it("rejects short proposals", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, side: "short" },
      context()
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain('Order side "short" is not supported');
  });

  it("rejects cover proposals", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, side: "cover" },
      context()
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain('Order side "cover" is not supported');
  });
});

function context(estimatedNotional = 10) {
  return {
    policy: enabledPolicy,
    portfolio,
    positions,
    dailyNotionalUsed: 0,
    dailyOrderCount: 0,
    estimatedNotional
  };
}
