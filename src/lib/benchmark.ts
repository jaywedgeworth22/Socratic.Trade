// SPY-benchmark equity-curve scoreboard.
//
// Compares the account's equity curve (from portfolio_snapshots) to a SPY buy-and-hold over the
// same window — the honest "are we beating the market net of cost" readout. Both series are
// normalized to 100 at the first common date so they overlay on one axis. SPY daily closes come
// from the same key-free history cascade every chart uses (fetchDailyOHLC). Never fabricates: if
// there isn't enough history or SPY can't be fetched, returns null and the UI degrades to "—".
//
// Deposits/withdrawals: no broker transfer ledger exists in this app, so external cash flows are
// INFERRED per snapshot gap as (cash delta) − (recorded trade cash delta), thresholded so
// dividends/fees/rounding don't register as transfers. When a material flow is detected, the
// account line is a chained time-weighted return (TWR) that neutralizes the flow, and the result
// is flagged `cashFlowAdjusted` so the UI can say so honestly. Without cash data (synthetic
// curves) behavior is unchanged: raw equity growth, `cashFlowAdjusted` false.

import { fetchDailyOHLC } from "./history";
import type { BenchmarkComparison, BenchmarkSeriesPoint, EquityCurvePoint, FillEvent } from "./types";

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

// ── External cash-flow inference ─────────────────────────────────────────────

/** A flow is only "external" when it clears both floors — below that, cash drift is
 *  indistinguishable from dividends/fees/rounding and must NOT be treated as a transfer. */
export const FLOW_MATERIALITY_PCT_OF_EQUITY = 0.5; // % of prior equity
export const FLOW_MATERIALITY_MIN_USD = 25;

/**
 * Infer external deposits/withdrawals per calendar date from the equity curve's cash balances
 * and the account's recorded fills. For each consecutive pair of (per-date last) snapshots:
 *
 *   externalFlow = (cash_i − cash_{i−1}) − (trade cash between the snapshots)
 *
 * where trade cash = +notional for sell/cover fills and −notional for buy/short fills. A flow
 * below the materiality floors is dropped (dividends, fees, rounding). Returns a map keyed by
 * the PERIOD-END snapshot date (the date whose period the flow landed in). Pure — exported for
 * direct unit testing. Returns an empty map when the curve carries no cash data.
 */
export function inferExternalCashFlows(
  equityCurve: EquityCurvePoint[],
  fills: FillEvent[] = []
): Map<string, number> {
  const flows = new Map<string, number>();
  // Collapse to one (last) point per calendar date, mirroring normalizeAgainstBenchmark.
  const byDate = new Map<string, { equity: number; cash: number; timestampMs: number }>();
  for (const p of equityCurve) {
    const d = isoDate(p.timestamp);
    const t = new Date(p.timestamp).getTime();
    if (!d || !Number.isFinite(t)) continue;
    if (!Number.isFinite(p.equity) || p.equity <= 0) continue;
    if (typeof p.cash !== "number" || !Number.isFinite(p.cash)) continue;
    byDate.set(d, { equity: p.equity, cash: p.cash, timestampMs: t });
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return flows;

  const sortedFills = fills
    .map((f) => ({ t: new Date(f.filledAt).getTime(), side: f.side, notional: f.notional }))
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.notional))
    .sort((a, b) => a.t - b.t);

  for (let i = 1; i < dates.length; i++) {
    const prev = byDate.get(dates[i - 1])!;
    const cur = byDate.get(dates[i])!;
    // Trade-driven cash movement between the two snapshots (exclusive, inclusive].
    let tradeCash = 0;
    for (const f of sortedFills) {
      if (f.t <= prev.timestampMs) continue;
      if (f.t > cur.timestampMs) break;
      tradeCash += f.side === "sell" || f.side === "cover" ? f.notional : -f.notional;
    }
    const flow = cur.cash - prev.cash - tradeCash;
    const threshold = Math.max((FLOW_MATERIALITY_PCT_OF_EQUITY / 100) * prev.equity, FLOW_MATERIALITY_MIN_USD);
    if (Math.abs(flow) >= threshold) flows.set(dates[i], round2(flow));
  }
  return flows;
}

/**
 * Pure normalization: align an equity curve with a date→close benchmark series, base both to 100
 * at the first equity date that has a benchmark close on/before it. Benchmark closes are looked up
 * carry-forward (last close on/before the date) so non-trading-day snapshots still align. Returns
 * null when either series has < 2 usable points. Exported for direct unit testing (no network).
 *
 * When `flowsByDate` (external deposits/withdrawals keyed by period-end date, from
 * inferExternalCashFlows) contains a flow inside the window, the account index becomes a chained
 * time-weighted return: each period's growth is equity_i / (equity_{i−1} + flow_i), so a
 * withdrawal no longer reads as a loss and a deposit no longer reads as a gain. Without flows the
 * math is byte-identical to plain equity growth.
 */
export function normalizeAgainstBenchmark(
  equityCurve: EquityCurvePoint[],
  benchmarkCloses: Array<{ date: string; close: number }>,
  benchmarkSymbol = "SPY",
  flowsByDate?: Map<string, number>
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
  // TWR chaining state: index_i = index_{i−1} × equity_i / (equity_{i−1} + flow_i).
  let chainedIndex = 100;
  let prevEquity: number | null = null;
  let flowsApplied = 0;
  let netExternalFlows = 0;
  for (const d of equityDates) {
    if (d < baseDate) continue;
    const eq = equityByDate.get(d)!;
    const bc = closeOnOrBefore(d);
    if (bc == null) continue;
    if (prevEquity != null) {
      const flow = flowsByDate?.get(d) ?? 0;
      const denominator = prevEquity + flow;
      if (flow !== 0 && denominator > 0) {
        chainedIndex *= eq / denominator;
        flowsApplied += 1;
        netExternalFlows += flow;
      } else {
        chainedIndex *= eq / prevEquity;
      }
    }
    prevEquity = eq;
    equityIndex.push({ date: d, index: round2(chainedIndex) });
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
    benchmarkSymbol,
    ...(flowsApplied > 0 ? { cashFlowAdjusted: true, netExternalFlows: round2(netExternalFlows) } : { cashFlowAdjusted: false })
  };
}

/**
 * Fetch SPY daily closes and compare them to the account equity curve. userId scopes the history
 * cache (consent-pooled). Optional `fills` (the same source's recorded fills) enable external
 * cash-flow inference so the account line is deposit/withdrawal-aware (TWR). Returns null on any
 * failure or insufficient data so callers degrade gracefully — never throws into the dashboard path.
 */
export async function computeSpyBenchmark(
  equityCurve: EquityCurvePoint[],
  userId?: string,
  now: number = Date.now(),
  fills?: FillEvent[]
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
  const flows = inferExternalCashFlows(equityCurve, fills ?? []);
  return normalizeAgainstBenchmark(equityCurve, closes, "SPY", flows.size > 0 ? flows : undefined);
}
