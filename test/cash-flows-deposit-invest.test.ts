import { describe, expect, it } from "vitest";
import { inferExternalCashFlows } from "../src/lib/cash-flows";
import { normalizeAgainstBenchmark } from "../src/lib/benchmark";

/**
 * Owner bug (Alpaca Paper / Sandbox): account shows ~+50% vs SPY despite ~$100k start
 * and flat/down trading. Sparse portfolio snapshots + missing fills for the buys made
 * "deposit then invest" look like pure equity growth (no external flow neutralized).
 */
describe("deposit then invest without fills (paper vs-SPY inflation)", () => {
  it("neutralizes concurrent deposit when cash falls and positions rise without fill receipts", () => {
    const equity = [
      {
        timestamp: "2026-01-02T16:00:00Z",
        equity: 66_000,
        cash: 66_000,
        positionsValue: 0,
        source: "paper" as const
      },
      {
        timestamp: "2026-06-01T16:00:00Z",
        equity: 99_000,
        cash: 5_000,
        positionsValue: 94_000,
        source: "paper" as const
      }
    ];
    const flows = inferExternalCashFlows(equity, []);
    // ~$33k external deposit (99k − 66k); must not be left as market alpha.
    expect(flows.get("2026-06-01")).toBeCloseTo(33_000, -2);

    const spy = [
      { date: "2026-01-02", close: 500 },
      { date: "2026-06-01", close: 520 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows)!;
    // Zero-mtm residual after neutralizing deposit → ~0% account TWR, not +50%.
    expect(r.accountReturnPct).toBeCloseTo(0, 0);
    expect(r.benchmarkReturnPct).toBeCloseTo(4, 0);
    expect(r.excessReturnPct).toBeLessThan(5);
    expect(r.cashFlowAdjusted).toBe(true);

    const raw = normalizeAgainstBenchmark(equity, spy)!;
    expect(raw.accountReturnPct).toBeGreaterThan(40);
  });

  it("does not invent a deposit for a pure cash→stock conversion (no equity change)", () => {
    const equity = [
      {
        timestamp: "2026-01-02T16:00:00Z",
        equity: 100_000,
        cash: 100_000,
        positionsValue: 0,
        source: "paper" as const
      },
      {
        timestamp: "2026-01-03T16:00:00Z",
        equity: 100_000,
        cash: 40_000,
        positionsValue: 60_000,
        source: "paper" as const
      }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBe(0);
  });

  it("does not treat modest mark-to-market after a buy as a deposit", () => {
    // Bought $50k of stock; positions then mark +$2k. Residual equity is small vs swap.
    const equity = [
      {
        timestamp: "2026-01-02T16:00:00Z",
        equity: 100_000,
        cash: 100_000,
        positionsValue: 0,
        source: "paper" as const
      },
      {
        timestamp: "2026-01-10T16:00:00Z",
        equity: 102_000,
        cash: 50_000,
        positionsValue: 52_000,
        source: "paper" as const
      }
    ];
    const flows = inferExternalCashFlows(equity, []);
    expect(flows.size).toBe(0);
    const spy = [
      { date: "2026-01-02", close: 100 },
      { date: "2026-01-10", close: 101 }
    ];
    const r = normalizeAgainstBenchmark(equity, spy, "SPY", flows.size ? flows : undefined)!;
    // Real ~+2% account return should survive (not neutralized as a deposit).
    expect(r.accountReturnPct).toBeCloseTo(2, 0);
  });
});
