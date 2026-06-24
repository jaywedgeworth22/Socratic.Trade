// SPY-benchmark equity-curve scoreboard.
//
// Compares the account's equity curve (from portfolio_snapshots) to a SPY buy-and-hold over the
// same window — the honest "are we beating the market net of cost" readout. Both series are
// normalized to 100 at the first common date so they overlay on one axis. SPY daily closes come
// from the same key-free history cascade every chart uses (fetchDailyOHLC). Never fabricates: if
// there isn't enough history or SPY can't be fetched, returns null and the UI degrades to "—".
//
// Caveat (surfaced in the UI): this compares equity GROWTH from the first snapshot date. It does
// NOT adjust for deposits/withdrawals, which would distort the curve — a TWR/invested-capital
// normalization is a documented follow-up.

import { fetchDailyOHLC } from "./history";
import type { BenchmarkComparison, BenchmarkSeriesPoint, EquityCurvePoint } from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalize any timestamp (ms epoch | ISO datetime | YYYY-MM-DD) to a calendar date string. */
function isoDate(ts: string | number | undefined): string | null {
  if (ts == null) return null;
  if (typeof ts === "number") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10);
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Pure normalization: align an equity curve with a date→close benchmark series, base both to 100
 * at the first equity date that has a benchmark close on/before it. Benchmark closes are looked up
 * carry-forward (last close on/before the date) so non-trading-day snapshots still align. Returns
 * null when either series has < 2 usable points. Exported for direct unit testing (no network).
 */
export function normalizeAgainstBenchmark(
  equityCurve: EquityCurvePoint[],
  benchmarkCloses: Array<{ date: string; close: number }>,
  benchmarkSymbol = "SPY"
): BenchmarkComparison | null {
  if (!equityCurve || equityCurve.length < 2 || benchmarkCloses.length < 2) return null;

  // Collapse equity to one (last) point per calendar date. The curve is chronological, so a later
  // entry for the same date overwrites an earlier one.
  const equityByDate = new Map<string, number>();
  for (const p of equityCurve) {
    const d = isoDate(p.timestamp);
    if (d && Number.isFinite(p.equity) && p.equity > 0) equityByDate.set(d, p.equity);
  }
  const equityDates = [...equityByDate.keys()].sort();
  if (equityDates.length < 2) return null;

  const bench = benchmarkCloses
    .filter((b) => Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (bench.length < 2) return null;

  const closeOnOrBefore = (date: string): number | null => {
    let lo = 0;
    let hi = bench.length - 1;
    let ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bench[mid].date <= date) {
        ans = bench[mid].close;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  let baseDate: string | null = null;
  for (const d of equityDates) {
    if (closeOnOrBefore(d) != null) {
      baseDate = d;
      break;
    }
  }
  if (!baseDate) return null;
  const baseEquity = equityByDate.get(baseDate)!;
  const baseBench = closeOnOrBefore(baseDate)!;

  const equityIndex: BenchmarkSeriesPoint[] = [];
  const benchmarkIndex: BenchmarkSeriesPoint[] = [];
  for (const d of equityDates) {
    if (d < baseDate) continue;
    const eq = equityByDate.get(d)!;
    const bc = closeOnOrBefore(d);
    if (bc == null) continue;
    equityIndex.push({ date: d, index: round2((eq / baseEquity) * 100) });
    benchmarkIndex.push({ date: d, index: round2((bc / baseBench) * 100) });
  }
  if (equityIndex.length < 2) return null;

  const accountReturnPct = equityIndex[equityIndex.length - 1].index - 100;
  const benchmarkReturnPct = benchmarkIndex[benchmarkIndex.length - 1].index - 100;
  return {
    equityIndex,
    benchmarkIndex,
    accountReturnPct: round2(accountReturnPct),
    benchmarkReturnPct: round2(benchmarkReturnPct),
    excessReturnPct: round2(accountReturnPct - benchmarkReturnPct),
    startDate: baseDate,
    endDate: equityIndex[equityIndex.length - 1].date,
    points: equityIndex.length,
    benchmarkSymbol
  };
}

/**
 * Fetch SPY daily closes and compare them to the account equity curve. userId scopes the history
 * cache (consent-pooled). Returns null on any failure or insufficient data so callers degrade
 * gracefully — never throws into the dashboard path.
 */
export async function computeSpyBenchmark(
  equityCurve: EquityCurvePoint[],
  userId?: string,
  now: number = Date.now()
): Promise<BenchmarkComparison | null> {
  if (!equityCurve || equityCurve.length < 2) return null;
  let bars;
  try {
    bars = await fetchDailyOHLC("SPY", now, userId);
  } catch {
    return null;
  }
  if (!bars || bars.length < 2) return null;
  const closes = bars
    .map((b) => ({ date: isoDate(b.time), close: b.close }))
    .filter((b): b is { date: string; close: number } => b.date != null && Number.isFinite(b.close));
  return normalizeAgainstBenchmark(equityCurve, closes, "SPY");
}
