// SPY-benchmark equity-curve scoreboard.
//
// Compares the account's equity curve (from portfolio_snapshots) to a SPY buy-and-hold over the
// same window — the honest "are we beating the market net of cost" readout. Both series are
// normalized to 100 at the first common date so they overlay on one axis. SPY daily closes come
// from the same key-free history cascade every chart uses (fetchDailyOHLC). Never fabricates: if
// there isn't enough history or SPY can't be fetched, returns null and the UI degrades to "—".
//
// Reading the scoreboard: excessReturnPct = accountReturnPct − benchmarkReturnPct. So if vs SPY
// is +5% and SPY rose +8% over the window, the account returned +13% after external capital.
//
// Deposits/withdrawals: no broker transfer ledger exists in this app, so external cash flows are
// INFERRED per snapshot gap (deposits +, withdrawals −, paper resets, ACH). All-cash gaps treat
// equity deltas as transfers. When cash + fills are available, flow = Δcash − trade cash, with
// guards so a cash→positions conversion without a recorded fill is not mistaken for a withdrawal.
//
// Headline accountReturnPct is capital-adjusted simple return:
//   (V_end − V_start − netExternalFlows) / V_start
// so every external dollar is stripped. The equity-index series still chains a TWR for the chart
// (same-dollars path). Flagged `cashFlowAdjusted` when any material flow was neutralized.

import { fetchDailyOHLC } from "./history";
// The external-cash-flow math lives in its own dependency-free module: the console's client
// components need it, and reaching it through this file dragged history.ts + the db barrel into
// the browser bundle. See the header of ./cash-flows for the full rationale.
import { capitalAdjustedReturnPct, inferExternalCashFlows, isoDate, round2 } from "./cash-flows";
import type { BenchmarkComparison, BenchmarkSeriesPoint, EquityCurvePoint, FillEvent } from "./types";

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
 *
 * excessReturnPct = accountReturnPct − benchmarkReturnPct (percentage points of out/under-performance
 * vs buying and holding SPY over the same calendar window with the same external capital timing
 * neutralized on the account side).
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
      } else if (flow !== 0 && denominator <= 0) {
        // Flow wiped (or more than wiped) prior equity — rebase with 0% for this period rather
        // than dividing by a non-positive base (which previously fell through to raw equity ratio
        // and re-introduced the withdrawal-as-loss distortion).
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

  // Headline return: prefer multi-period TWR (equity index last − 100) so mid-window
  // deposits/withdrawals are period-weighted correctly. When a single wipe-level withdrawal
  // makes TWR rebase (flow ≤ −start equity), capital-adjusted simple return is used as a
  // sanity cross-check only for the netExternalFlows annotation.
  //
  // Capital-adjusted simple: (V_end − V_start − netFlows) / V_start — intuitive for
  // "started $100k, withdrew $X, now $Y" and matches SPY buy-hold when flows are sparse.
  const startEq = equityByDate.get(baseDate);
  const endDate = equityIndex[equityIndex.length - 1].date;
  const endEq = equityByDate.get(endDate);
  let netFlowsInWindow = 0;
  if (flowsByDate) {
    for (const d of equityDates) {
      if (d <= baseDate || d > endDate) continue;
      netFlowsInWindow += flowsByDate.get(d) ?? 0;
    }
  }
  const twrReturnPct = equityIndex[equityIndex.length - 1].index - 100;
  const capitalAdj =
    startEq != null && endEq != null
      ? capitalAdjustedReturnPct(startEq, endEq, netFlowsInWindow)
      : null;
  // Use capital-adjusted when we detected flows (strips every external dollar from the headline).
  // Exception: near-total withdrawal (flow wipes ≥95% of start equity) — TWR rebase treats leftover
  // crumbs as new principal (0% period), while capital-adj with an overstated −start flow can show
  // a phantom small gain. Prefer TWR there.
  let accountReturnPct = round2(twrReturnPct);
  if (flowsApplied > 0 && capitalAdj != null && startEq != null) {
    const wipeLevel = netFlowsInWindow < 0 && -netFlowsInWindow >= startEq * 0.95;
    accountReturnPct = wipeLevel ? round2(twrReturnPct) : capitalAdj;
  }
  const benchmarkReturnPct = benchmarkIndex[benchmarkIndex.length - 1].index - 100;
  const flowsDetected = flowsApplied > 0 || Math.abs(netFlowsInWindow) >= 0.01;
  return {
    equityIndex,
    benchmarkIndex,
    accountReturnPct: round2(accountReturnPct),
    benchmarkReturnPct: round2(benchmarkReturnPct),
    excessReturnPct: round2(accountReturnPct - benchmarkReturnPct),
    startDate: baseDate,
    endDate,
    points: equityIndex.length,
    benchmarkSymbol,
    ...(flowsDetected
      ? { cashFlowAdjusted: true, netExternalFlows: round2(netFlowsInWindow) }
      : { cashFlowAdjusted: false })
  };
}

/**
 * Fetch SPY daily closes and compare them to the account equity curve. userId scopes the history
 * cache (consent-pooled). Optional `fills` (the same source's recorded fills) enable external
 * cash-flow inference so the account line is deposit/withdrawal-aware (TWR). Returns null on any
 * failure or insufficient data so callers degrade gracefully — never throws into the dashboard path.
 *
 * Synthetic fill-only curves (no real portfolio snapshots) are refused — those start at a fake
 * $100 equity base and are not comparable to SPY for an account holding real capital.
 */
export async function computeSpyBenchmark(
  equityCurve: EquityCurvePoint[],
  userId?: string,
  now: number = Date.now(),
  fills?: FillEvent[]
): Promise<BenchmarkComparison | null> {
  if (!equityCurve || equityCurve.length < 2) return null;
  // Refuse synthetic paper curves (`syntheticPaperCurve` uses equity = 100 + realized with no cash
  // fields). IMPORTANT: do not let a single live tip (which has cash) "upgrade" a synthetic
  // history into a real TWR — that made $100-base fill curves + $100k tip read as +tens of %
  // "account return" on paper/sandbox accounts. Require ≥2 real snapshot points.
  const realCurve = equityCurve.filter(
    (p) => typeof p.cash === "number" || typeof p.positionsValue === "number"
  );
  if (realCurve.length < 2) return null;
  // Prefer the real-snapshot sub-curve (includes a live tip when present).
  equityCurve = realCurve;
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
