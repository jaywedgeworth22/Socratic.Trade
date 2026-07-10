import { describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../app/dashboard-types";
import type { EquityCurvePoint, EquityPosition, Portfolio, TradingPolicy } from "../src/lib/types";
import { deriveMarkToMarket, deriveProtection, deriveRiskUtilization, selectEquityWindow } from "../app/console/lib/derive";
import type { EquityOrder } from "../src/lib/types";

function snapshotWith(input: {
  positions?: EquityPosition[];
  portfolio?: Partial<Portfolio>;
  dailyStats?: DashboardSnapshot["dailyStats"];
  policy?: Partial<TradingPolicy>;
}): DashboardSnapshot {
  return {
    positions: input.positions ?? [],
    portfolio: input.portfolio as Portfolio | undefined,
    dailyStats: input.dailyStats ?? { orderCount: 0, openingOrderCount: 0, notional: 0 },
    policy: {
      maxDailyOrders: 6,
      maxDailyNotional: 10_000,
      ...input.policy
    } as TradingPolicy
  } as DashboardSnapshot;
}

describe("console live-data derivations", () => {
  it("derives open mark-to-market from the signed open book", () => {
    const snapshot = snapshotWith({
      positions: [
        { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_250 },
        { symbol: "MSFT", quantity: 5, averageCost: 200, marketValue: 950 }
      ],
      portfolio: { equityMarketValue: 2_200, cash: 500, buyingPower: 750 } satisfies Partial<Portfolio>
    });

    expect(deriveMarkToMarket(snapshot)).toEqual({
      costBasis: 2_000,
      marketValue: 2_200,
      unrealizedPnl: 200,
      unrealizedPct: 10,
      positionsValue: 2_200,
      cash: 500,
      buyingPower: 750
    });
  });

  it("derives daily notional, order, and deployed-capital utilization", () => {
    const snapshot = snapshotWith({
      positions: [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_200 }],
      portfolio: { totalMarketValue: 2_000, equityMarketValue: 1_200 } satisfies Partial<Portfolio>,
      dailyStats: { orderCount: 3, openingOrderCount: 2, notional: 2_500 },
      policy: { maxDailyOrders: 8, maxDailyNotional: 5_000 }
    });

    expect(deriveRiskUtilization(snapshot)).toEqual({
      dailyNotional: { used: 2_500, limit: 5_000, pct: 50 },
      dailyOrders: { used: 2, limit: 8, pct: 25 },
      investedCapital: { used: 1_200, limit: 2_000, pct: 60 }
    });
  });

  it("treats missing positions as zero deployed capital in degraded snapshots", () => {
    const snapshot = snapshotWith({
      dailyStats: { orderCount: 0, openingOrderCount: 0, notional: 0 },
      policy: { maxDailyOrders: 8, maxDailyNotional: 5_000 }
    });
    delete (snapshot as Partial<DashboardSnapshot>).positions;

    expect(deriveRiskUtilization(snapshot).investedCapital).toEqual({
      used: 0,
      limit: undefined,
      pct: undefined
    });
  });

  it("prefers today's equity points for the intraday chart when enough exist", () => {
    const points: EquityCurvePoint[] = [
      { timestamp: "2026-07-03T20:00:00.000Z", equity: 9_800, source: "live" },
      { timestamp: "2026-07-04T14:00:00.000Z", equity: 10_000, source: "live" },
      { timestamp: "2026-07-04T15:00:00.000Z", equity: 10_120, source: "live" }
    ];

    const selected = selectEquityWindow(points, new Date("2026-07-04T16:00:00.000Z"));
    expect(selected.label).toBe("Intraday mark-to-market");
    expect(selected.points).toEqual(points.slice(1));
  });

  it("falls back to the most recent window when today has fewer than two points", () => {
    const points = Array.from({ length: 30 }, (_, index) => ({
      timestamp: `2026-06-${String(index + 1).padStart(2, "0")}T20:00:00.000Z`,
      equity: 10_000 + index,
      source: "paper" as const
    }));

    const selected = selectEquityWindow(points, new Date("2026-07-04T16:00:00.000Z"));
    expect(selected.label).toBe("Recent equity");
    expect(selected.points).toHaveLength(24);
    expect(selected.points[0]).toEqual(points[6]);
  });
});

describe("deriveProtection — per-position stop plan annotation (never a silent override)", () => {
  const longPos = { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 900 };
  const basePolicy = { riskRules: { stopLossPct: 8 }, shortSellingEnabled: false } as TradingPolicy;
  const noOrders: EquityOrder[] = [];

  it("no plan (or 'default') leaves the base protection untouched", () => {
    const withoutPlan = deriveProtection(longPos, noOrders, basePolicy);
    const withDefaultPlan = deriveProtection(longPos, noOrders, basePolicy, { style: "default", avgCost: 100 });
    expect(withoutPlan).toEqual(withDefaultPlan);
    expect(withoutPlan.label).toMatch(/App stop/);
  });

  it("a 'fixed'/'atr'/'trailing' plan annotates the detail without changing the label/tone", () => {
    const base = deriveProtection(longPos, noOrders, basePolicy);
    const withPlan = deriveProtection(longPos, noOrders, basePolicy, { style: "trailing", avgCost: 100 });
    expect(withPlan.label).toBe(base.label);
    expect(withPlan.tone).toBe(base.tone);
    expect(withPlan.detail).toMatch(/Per-position plan: Trailing/);
  });

  it("a 'none' plan is surfaced prominently (never blended into the generic no-protection case), with its rationale", () => {
    // A bare policy with NO stop configured at all would otherwise say "nothing protects" — the
    // 'none' plan must still be visibly distinct from that (an explicit choice, not an oversight).
    const barePolicy = { riskRules: { stopLossPct: 0 }, shortSellingEnabled: false } as TradingPolicy;
    const info = deriveProtection(longPos, noOrders, barePolicy, {
      style: "none", rationale: "high-conviction thesis, riding through drawdown", avgCost: 100
    });
    expect(info.label).toBe("No stop (LLM choice)");
    expect(info.tone).toBe("warn");
    expect(info.detail).toMatch(/deliberate LLM\/owner choice/);
    expect(info.detail).toMatch(/high-conviction thesis, riding through drawdown/);
  });

  it("a 'none' plan still reports an ACTUALLY-resting broker stop honestly (accuracy over the plan's intent)", () => {
    const brokerStopOrder: EquityOrder[] = [
      { id: "o1", symbol: "AAPL", side: "sell", type: "stop_market", state: "new", quantity: 10, timeInForce: "gtc", createdAt: new Date().toISOString() }
    ];
    const info = deriveProtection(longPos, brokerStopOrder, basePolicy, { style: "none", avgCost: 100 });
    expect(info.label).toBe("Broker stop"); // the base result is preserved as the label
    expect(info.tone).toBe("pos"); // still accurately reflects real resting protection
    expect(info.detail).toMatch(/deliberate LLM\/owner choice/); // but the plan is still surfaced
  });
});
