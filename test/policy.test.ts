import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
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
  enabled: true,
  paperMode: false,
  strategyAuthority: "decide",
  accountNumber: "A1",
  allowlist: ["AAPL", "VOO"]
};

const proposal: TradeProposal = {
  symbol: "VOO",
  side: "buy",
  type: "market",
  dollarAmount: 10,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test"
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

  it("blocks symbols outside the allowlist", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "TSLA" }, context());
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not in the allowed universe");
  });

  it("allows S&P 500 symbols when the S&P universe is selected", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, {
      ...context(),
      policy: { ...enabledPolicy, universe: "sp500", allowlist: [] },
      estimatedNotional: 10
    });
    expect(decision.approved).toBe(true);
  });

  it("blocks orders over max notional", () => {
    const decision = evaluateTradeProposal({ ...proposal, dollarAmount: 1200 }, context(1200));
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("exceeds max order notional");
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
    const stopLoss = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, {
      ...context(),
      positions: [{ symbol: "AAPL", quantity: 5, averageCost: 250, marketValue: 1000, sector: "Technology" }]
    });
    const takeProfit = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, {
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

  it("blocks when kill switch is active", () => {
    const decision = evaluateTradeProposal(proposal, {
      ...context(),
      policy: { ...enabledPolicy, killSwitch: true }
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Kill switch");
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
