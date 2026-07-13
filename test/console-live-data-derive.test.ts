import { describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../app/dashboard-types";
import type { EquityCurvePoint, EquityPosition, Portfolio, TradingPolicy } from "../src/lib/types";
import { deriveMarkToMarket, deriveProtection, deriveRiskUtilization, deriveSpend, selectEquityWindow } from "../app/console/lib/derive";
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

  it("resolves a percent daily cap against current NAV and exposes fixed-cap scale", () => {
    const percent = snapshotWith({
      portfolio: { totalMarketValue: 100 } satisfies Partial<Portfolio>,
      policy: { maxDailyNotional: undefined, maxDailyPctOfNav: 20 }
    });
    expect(deriveSpend(percent)).toMatchObject({
      capMode: "pct_nav",
      capConfiguredValue: 20,
      capNotional: 20,
      capPctOfNav: 20
    });

    const fixed = snapshotWith({
      portfolio: { totalMarketValue: 100 } satisfies Partial<Portfolio>,
      policy: { maxDailyNotional: 1_000, maxDailyPctOfNav: undefined }
    });
    expect(deriveSpend(fixed)).toMatchObject({
      capMode: "dollar",
      capConfiguredValue: 1_000,
      capNotional: 1_000,
      capPctOfNav: 1_000
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

  it("a 'trailing' plan builds its OWN label from the plan, not the account-wide base's label/mechanism (an account configured with only a FLAT stop must not show 'App stop -8%' for a position actually protected by a trail)", () => {
    const base = deriveProtection(longPos, noOrders, basePolicy); // flat stop only, no trailing configured
    expect(base.label).toMatch(/App stop/);
    const withPlan = deriveProtection(longPos, noOrders, basePolicy, { style: "trailing", avgCost: 100 });
    expect(withPlan.label).not.toBe(base.label);
    expect(withPlan.label).toBe("Trailing plan");
    expect(withPlan.tone).toBe("pos");
    expect(withPlan.detail).toMatch(/Per-position plan: Trailing/);
  });

  it("a plan's label is 'paused' (tone warn) while the system is Stopped, mirroring the account-wide app-managed pause (the plan's own enforcement is the same scheduler-tick monitor)", () => {
    const haltedPolicy = { ...basePolicy, systemState: "halted" } as TradingPolicy;
    const info = deriveProtection(longPos, noOrders, haltedPolicy, { style: "fixed", avgCost: 100 });
    expect(info.label).toBe("Fixed plan · paused");
    expect(info.tone).toBe("warn");
    expect(info.detail).toMatch(/paused while the system is Stopped/);
  });

  it("a plan on top of a REAL resting broker stop keeps the broker-stop label/tone verbatim (accuracy over the plan's own label)", () => {
    const brokerStopOrder: EquityOrder[] = [
      { id: "o1", symbol: "AAPL", side: "sell", type: "stop_market", state: "new", quantity: 10, timeInForce: "gtc", createdAt: new Date().toISOString() }
    ];
    const info = deriveProtection(longPos, brokerStopOrder, basePolicy, { style: "atr", avgCost: 100 });
    expect(info.label).toBe("Broker stop");
    expect(info.tone).toBe("pos");
    expect(info.detail).toMatch(/Per-position plan: ATR/);
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

  it("a 'none' plan overrides a CONFIG-derived 'App stop...' label (the account has a stop % configured, but every enforcement layer suppresses it for this symbol once 'none' is set — only a REAL resting broker order should ever look protected)", () => {
    const base = deriveProtection(longPos, noOrders, basePolicy); // stopLossPct: 8, no orders
    expect(base.label).toMatch(/App stop/);
    expect(base.tone).toBe("pos");
    const info = deriveProtection(longPos, noOrders, basePolicy, { style: "none", avgCost: 100 });
    expect(info.label).toBe("No stop (LLM choice)");
    expect(info.tone).toBe("warn");
  });

  it("a 'fixed'/'atr'/'trailing' plan shows its OWN label when the account has no matching stop configured (the plan's fallback distance is real, active protection — never render '—')", () => {
    const barePolicy = { riskRules: { stopLossPct: 0 }, shortSellingEnabled: false } as TradingPolicy;
    const base = deriveProtection(longPos, noOrders, barePolicy);
    expect(base.label).toBeNull(); // honestly "nothing configured" on its own
    const withPlan = deriveProtection(longPos, noOrders, barePolicy, { style: "trailing", avgCost: 100 });
    expect(withPlan.label).not.toBeNull();
    expect(withPlan.label).toMatch(/Trailing/);
    expect(withPlan.tone).toBe("pos");
    expect(withPlan.detail).toMatch(/Per-position plan: Trailing/);
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

  it("does NOT show an active 'Fixed/ATR/Trailing plan' badge for a SHORT while short selling is off — every enforcement layer skips the short, so the muted/unprotected base state is preserved (Codex review, PR #1371)", () => {
    // A short opened while shorting was enabled (persisting a "fixed" plan at fill), then policy toggled
    // shortSellingEnabled off. generateProactiveRiskProposals, synthetic-stops, and broker-protective-
    // stops all skip this short entirely, so the plan is NOT actually protecting it. Pre-fix the final
    // branch returned { label: "Fixed plan", tone: "pos" } — a green "active protection" badge for a
    // position with zero enforcement backing it.
    const shortPos = { symbol: "TSLA", quantity: -10, averageCost: 100, marketValue: -1000 };
    const activePolicy = { riskRules: { stopLossPct: 8 }, shortSellingEnabled: false, systemState: "active" } as TradingPolicy;
    const info = deriveProtection(shortPos, noOrders, activePolicy, { style: "fixed", avgCost: 100 });
    expect(info.label).toBeNull(); // muted/unsafe state preserved — renders "—", not a green badge
    expect(info.tone).toBe("muted");
    expect(info.detail).toMatch(/never takes effect while short selling is off/); // plan still surfaced in the tooltip
    expect(info.detail).toMatch(/Short position, but short selling is off/); // base's muted explanation kept
  });
});
