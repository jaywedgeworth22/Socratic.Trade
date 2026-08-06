import { describe, expect, it } from "vitest";
import { normalizeAgainstBenchmark } from "../src/lib/benchmark";
import { inferExternalCashFlows, FLOW_MATERIALITY_MIN_USD } from "../src/lib/cash-flows";
import type { EquityCurvePoint, FillEvent } from "../src/lib/types";

function curve(points: Array<[string, number]>): EquityCurvePoint[] {
  return points.map(([timestamp, equity]) => ({ timestamp, equity, source: "paper" as const }));
}

function cashCurve(points: Array<[string, number, number]>): EquityCurvePoint[] {
  return points.map(([timestamp, equity, cash]) => ({ timestamp, equity, cash, source: "live" as const }));
}

function fill(input: { filledAt: string; side: FillEvent["side"]; notional: number }): FillEvent {
  return {
    id: `f-${input.filledAt}-${input.side}`,
    accountNumber: "A1",
    source: "live",
    symbol: "AAPL",
    side: input.side,
    quantity: 1,
    price: input.notional,
    notional: input.notional,
    status: "filled",
    filledAt: input.filledAt
  };
}

describe("normalizeAgainstBenchmark", () => {
  it("bases both series to 100 and computes returns + excess", () => {
    const equity = curve([
      ["2026-01-02T16:00:00.000Z", 100_000],
      ["2026-01-03T16:00:00.000Z", 110_000] // +10%
    ]);
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-01-03", close: 525 } // +5%
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    expect(r).not.toBeNull();
    expect(r.equityIndex[0].index).toBe(100);
    expect(r.benchmarkIndex[0].index).toBe(100);
    expect(r.accountReturnPct).toBeCloseTo(10, 5);
    expect(r.benchmarkReturnPct).toBeCloseTo(5, 5);
    expect(r.excessReturnPct).toBeCloseTo(5, 5);
    expect(r.benchmarkSymbol).toBe("SPY");
    expect(r.startDate).toBe("2026-01-02");
    expect(r.endDate).toBe("2026-01-03");
  });

  it("reports underperformance as negative excess", () => {
    const equity = curve([
      ["2026-02-02T16:00:00Z", 100_000],
      ["2026-02-09T16:00:00Z", 98_000] // -2%
    ]);
    const spy = [
      { date: "2026-02-02", close: 500 },
      { date: "2026-02-09", close: 515 } // +3%
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    expect(r.accountReturnPct).toBeCloseTo(-2, 5);
    expect(r.benchmarkReturnPct).toBeCloseTo(3, 5);
    expect(r.excessReturnPct).toBeCloseTo(-5, 5);
  });

  it("carries the benchmark close forward for non-trading-day snapshots", () => {
    // Snapshot on a Sunday (2026-01-04) with no SPY bar that day → uses Friday's (01-02) close.
    const equity = curve([
      ["2026-01-02T16:00:00Z", 100_000],
      ["2026-01-04T16:00:00Z", 105_000]
    ]);
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-01-05", close: 510 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    // 01-04 carries forward 01-02 close (500) → benchmark index stays 100 on that date.
    const p = r.benchmarkIndex.find((x) => x.date === "2026-01-04");
    expect(p?.index).toBe(100);
  });

  it("collapses multiple same-day snapshots to the last equity of the day", () => {
    const equity = curve([
      ["2026-03-02T14:00:00Z", 100_000],
      ["2026-03-02T20:00:00Z", 101_000], // later same day wins
      ["2026-03-03T16:00:00Z", 103_000]
    ]);
    const spy = [
      { date: "2026-03-02", close: 400 },
      { date: "2026-03-03", close: 404 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    // base equity = 101_000 (last on 03-02); 03-03 = 103_000 → +1.98%
    expect(r.accountReturnPct).toBeCloseTo(1.98, 1);
    expect(r.points).toBe(2);
  });

  it("returns null on insufficient data", () => {
    expect(normalizeAgainstBenchmark(curve([["2026-01-02T16:00:00Z", 100_000]]), [{ date: "2026-01-02", close: 1 }, { date: "2026-01-03", close: 2 }])).toBeNull();
    expect(normalizeAgainstBenchmark(curve([["2026-01-02T16:00:00Z", 100_000], ["2026-01-03T16:00:00Z", 1]]), [])).toBeNull();
  });

  it("ignores non-positive equity points", () => {
    const equity = curve([
      ["2026-04-01T16:00:00Z", 0], // dropped
      ["2026-04-02T16:00:00Z", 100_000],
      ["2026-04-03T16:00:00Z", 102_000]
    ]);
    const spy = [
      { date: "2026-04-02", close: 500 },
      { date: "2026-04-03", close: 505 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    expect(r.startDate).toBe("2026-04-02");
    expect(r.points).toBe(2);
  });

  it("marks the unadjusted result cashFlowAdjusted:false (default behavior unchanged)", () => {
    const equity = curve([
      ["2026-01-02T16:00:00Z", 100_000],
      ["2026-01-03T16:00:00Z", 110_000]
    ]);
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-01-03", close: 525 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy)!;
    expect(r.accountReturnPct).toBeCloseTo(10, 5);
    expect(r.cashFlowAdjusted).toBe(false);
    expect(r.netExternalFlows).toBeUndefined();
  });

  it("neutralizes a withdrawal via time-weighted chaining (the owner's -80% bug)", () => {
    // $100k account; owner withdraws $80k with no trading. Raw growth reads -80%;
    // TWR with the inferred -$80k flow reads ~0%.
    const equity = cashCurve([
      ["2026-05-01T16:00:00Z", 100_000, 100_000],
      ["2026-05-02T16:00:00Z", 20_000, 20_000]
    ]);
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-05-02")).toBeCloseTo(-80_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    expect(r.netExternalFlows).toBeCloseTo(-80_000, 2);
    expect(r.accountReturnPct).toBeCloseTo(0, 2);
    // Without the flows map the old distorted figure comes back — pinned so the fix is visible.
    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeCloseTo(-80, 2);
  });

  it("does not misread trade-driven cash changes as transfers", () => {
    // Cash fell $50k because the account BOUGHT $50k of stock — equity unchanged, no flow.
    const equity = cashCurve([
      ["2026-05-01T16:00:00Z", 100_000, 100_000],
      ["2026-05-02T16:00:00Z", 100_000, 50_000]
    ]);
    const flows = inferExternalCashFlows(equity, [fill({ filledAt: "2026-05-02T15:00:00Z", side: "buy", notional: 50_000 })]);
    expect(flows.size).toBe(0);
  });

  it("keeps genuine performance visible alongside a deposit", () => {
    // $100k grows 10% AND a $100k deposit lands: equity 100k → 210k, cash +100k external.
    const equity = cashCurve([
      ["2026-06-01T16:00:00Z", 100_000, 100_000],
      ["2026-06-02T16:00:00Z", 210_000, 200_000]
    ]);
    const spy = [
      { date: "2026-06-01", close: 500 },
      { date: "2026-06-02", close: 500 }
    ];
    // $10k of the equity rise is a market gain; cash went 100k → 200k with no trades = +100k flow.
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-06-02")).toBeCloseTo(100_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    // Capital-adjusted: (210k − 100k − 100k deposit) / 100k = +10% market P&L on starting capital.
    expect(r.accountReturnPct).toBeCloseTo(10, 2);
    expect(r.netExternalFlows).toBeCloseTo(100_000, 2);
  });

  it("neutralizes a withdrawal while positions stay open", () => {
    // Started $100k (50k cash + 50k stock). Withdraw $20k cash. Stock flat. Equity 100k → 80k.
    // Must read ~0% account return, not −20%.
    const equity = [
      { timestamp: "2026-05-01T16:00:00Z", equity: 100_000, cash: 50_000, positionsValue: 50_000, source: "paper" as const },
      { timestamp: "2026-05-02T16:00:00Z", equity: 80_000, cash: 30_000, positionsValue: 50_000, source: "paper" as const }
    ];
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-05-02")).toBeCloseTo(-20_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    expect(r.netExternalFlows).toBeCloseTo(-20_000, 2);
    // (80k − 100k − (−20k)) / 100k = 0%
    expect(r.accountReturnPct).toBeCloseTo(0, 2);
    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeCloseTo(-20, 2);
  });

  it("nets deposit then withdrawal to the true market P&L", () => {
    // 100k all cash → +50k deposit → 150k → −30k withdrawal → 120k → positions mark +5k → 125k.
    const equity = [
      { timestamp: "2026-01-02T16:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 0, source: "paper" as const },
      { timestamp: "2026-02-02T16:00:00Z", equity: 150_000, cash: 150_000, positionsValue: 0, source: "paper" as const },
      { timestamp: "2026-03-02T16:00:00Z", equity: 120_000, cash: 120_000, positionsValue: 0, source: "paper" as const },
      // Deploy cash into stock (fill), then mark up:
      { timestamp: "2026-03-03T16:00:00Z", equity: 120_000, cash: 20_000, positionsValue: 100_000, source: "paper" as const },
      { timestamp: "2026-04-02T16:00:00Z", equity: 125_000, cash: 20_000, positionsValue: 105_000, source: "paper" as const }
    ];
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-02-02", close: 500 },
      { date: "2026-03-02", close: 500 },
      { date: "2026-03-03", close: 500 },
      { date: "2026-04-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, [
      fill({ filledAt: "2026-03-03T15:00:00Z", side: "buy", notional: 100_000 })
    ]);
    expect(flows.get("2026-02-02")).toBeCloseTo(50_000, 2);
    expect(flows.get("2026-03-02")).toBeCloseTo(-30_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.netExternalFlows).toBeCloseTo(20_000, 2); // +50 − 30
    // (125 − 100 − 20) / 100 = +5%
    expect(r.accountReturnPct).toBeCloseTo(5, 1);
  });

  it("ignores sub-threshold cash drift (dividends/fees are not transfers)", () => {
    const equity = cashCurve([
      ["2026-07-01T16:00:00Z", 100_000, 10_000],
      ["2026-07-02T16:00:00Z", 100_020, 10_020] // +$20 < max(0.5% of 100k, $0.50)
    ]);
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBe(0);
  });

  it("treats no-cash flat books as transfers when equity jumps without trades", () => {
    // Missing cash fields but no positions metadata and no fills → equity delta is a transfer
    // (paper reset / deposit). Previously these returned no flows and raw TWR misread them as alpha.
    const flows = inferExternalCashFlows(
      curve([
        ["2026-08-01T16:00:00Z", 100_000],
        ["2026-08-02T16:00:00Z", 50_000]
      ]),
      []
    );
    expect(flows.get("2026-08-02")).toBeCloseTo(-50_000, 2);
  });

  it("all-cash prefers cash≈equity even when positionsValue is wrongly equal to equity", () => {
    // Regression: isAllCash used to check positionsValue FIRST, so a buggy positionsValue=equity
    // (while cash is full equity) blocked the all-cash deposit path and inflated account return.
    const equity = [
      { timestamp: "2026-01-02T16:00:00Z", equity: 66_000, cash: 66_000, positionsValue: 66_000, source: "paper" as const },
      { timestamp: "2026-02-02T16:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 100_000, source: "paper" as const }
    ];
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-02-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.get("2026-02-02")).toBeCloseTo(34_000, 2);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.accountReturnPct).toBeCloseTo(0, 1);
    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeGreaterThan(50);
  });

  it("all-cash paper resets/deposits are neutralized (owner +31% vs SPY bug)", () => {
    // All-cash account: equity drifts 76k → 99.9k from deposits/resets with no trading.
    // Raw growth reads ~+31%; TWR with all-cash flow inference reads ~0%, so vs SPY ≈ −SPY.
    const equity = cashCurve([
      ["2026-01-02T16:00:00Z", 76_000, 76_000],
      ["2026-02-02T16:00:00Z", 80_000, 80_000],
      ["2026-03-02T16:00:00Z", 90_000, 90_000],
      ["2026-04-02T16:00:00Z", 99_900, 99_900]
    ]).map((p) => ({ ...p, positionsValue: 0 }));
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-02-02", close: 510 },
      { date: "2026-03-02", close: 520 },
      { date: "2026-04-02", close: 530 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBeGreaterThan(0);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    expect(r.accountReturnPct).toBeCloseTo(0, 1);
    expect(r.benchmarkReturnPct).toBeCloseTo(6, 1);
    // vs SPY = account − SPY ≈ −6% (holding cash underperformed a rising market)
    expect(r.excessReturnPct).toBeCloseTo(-6, 1);
    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeGreaterThan(30);
  });

  it("does not treat a cash→positions conversion without fills as a withdrawal", () => {
    // Bought $210 of stock (cash 210→0, positions 0→180 after a mark-to-market loss).
    // Missing fill must NOT invent a −$210 withdrawal.
    const equity = [
      { timestamp: "2026-01-02T16:00:00Z", equity: 210, cash: 210, positionsValue: 0, source: "live" as const },
      { timestamp: "2026-02-02T16:00:00Z", equity: 180, cash: 0, positionsValue: 180, source: "live" as const }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBe(0);
  });

  it("keeps real mark-to-market losses visible after a buy (owner −77.7% path)", () => {
    // After buying, equity falls 210 → 46.84 from trading — that IS underperformance vs flat SPY.
    const equity = [
      { timestamp: "2026-01-02T16:00:00Z", equity: 210, cash: 210, positionsValue: 0, source: "live" as const },
      { timestamp: "2026-02-02T16:00:00Z", equity: 180, cash: 0, positionsValue: 180, source: "live" as const },
      { timestamp: "2026-03-02T16:00:00Z", equity: 100, cash: 0, positionsValue: 100, source: "live" as const },
      { timestamp: "2026-04-02T16:00:00Z", equity: 46.84, cash: 0, positionsValue: 46.84, source: "live" as const }
    ];
    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-02-02", close: 500 },
      { date: "2026-03-02", close: 500 },
      { date: "2026-04-02", close: 500 }
    ];
    const flows = inferExternalCashFlows(equity, []);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows.size > 0 ? flows : undefined)!;
    expect(r.accountReturnPct).toBeCloseTo(-77.7, 1);
    expect(r.benchmarkReturnPct).toBeCloseTo(0, 1);
    expect(r.excessReturnPct).toBeCloseTo(-77.7, 1);
  });

  it("rebases instead of distorting when a flow wipes prior equity (denom <= 0)", () => {
    const equity = cashCurve([
      ["2026-05-01T16:00:00Z", 100_000, 100_000],
      ["2026-05-02T16:00:00Z", 5_000, 5_000] // withdrew essentially everything
    ]);
    const spy = [
      { date: "2026-05-01", close: 500 },
      { date: "2026-05-02", close: 500 }
    ];
    const flows = new Map([["2026-05-02", -100_000]]);
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    expect(r.cashFlowAdjusted).toBe(true);
    // Rebase with 0% for the wiped period — leftover $5k is new principal, not a −95% loss.
    expect(r.accountReturnPct).toBeCloseTo(0, 1);
  });
});

describe("computeSpyBenchmark synthetic curve guard", () => {
  it("refuses a synthetic $100-base fill curve even when tipped with a live $100k snapshot", async () => {
    // Repro: paperAverage/syntheticPaperCurve builds equity=100+realized; dashboard tips with
    // live totalMarketValue ~$100k. Old hasRealSnapshot=some(cash) treated the tip as enough
    // and TWR read ~+tens of thousands % as "Your account".
    const { computeSpyBenchmark } = await import("../src/lib/benchmark");
    const synthetic: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100, source: "paper" },
      { timestamp: "2026-07-15T16:00:00Z", equity: 150, source: "paper" },
      {
        timestamp: "2026-08-05T16:00:00Z",
        equity: 100_000,
        cash: 95_000,
        positionsValue: 5_000,
        source: "paper"
      }
    ];
    // fetchDailyOHLC may be called if guard fails — mock by only testing the filter: with a
    // single real point the function returns null before network.
    const result = await computeSpyBenchmark(synthetic, "local", Date.parse("2026-08-05T16:00:00Z"), []);
    expect(result).toBeNull();
  });

  it("accepts two real snapshots (with cash) and computes a sane small return", async () => {
    const { computeSpyBenchmark } = await import("../src/lib/benchmark");
    const real: EquityCurvePoint[] = [
      { timestamp: "2026-07-01T16:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 0, source: "paper" },
      { timestamp: "2026-08-05T16:00:00Z", equity: 99_000, cash: 90_000, positionsValue: 9_000, source: "paper" }
    ];
    // May return null if SPY history fetch fails in offline CI — either null or a small negative
    // account return is acceptable; never a huge positive.
    const result = await computeSpyBenchmark(real, "local", Date.parse("2026-08-05T16:00:00Z"), []);
    if (result) {
      expect(result.accountReturnPct).toBeLessThan(5);
      expect(result.accountReturnPct).toBeGreaterThan(-20);
    }
  });
});
