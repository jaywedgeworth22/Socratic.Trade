import { describe, expect, it } from "vitest";
import { normalizeAgainstBenchmark } from "../src/lib/benchmark";
import type { EquityCurvePoint } from "../src/lib/types";

function curve(points: Array<[string, number]>): EquityCurvePoint[] {
  return points.map(([timestamp, equity]) => ({ timestamp, equity, source: "paper" as const }));
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
});
