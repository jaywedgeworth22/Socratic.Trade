// SPY-benchmark equity-curve scoreboard.
//
// Compares the account's equity curve (from portfolio_snapshots) to SPY over the same window —
// the honest "are we beating the market net of cost" readout. Both series are normalized to 100
// at the first common date so they overlay on one axis. SPY daily closes come from the same
// key-free history cascade every chart uses (fetchDailyOHLC). Never fabricates: if there isn't
// enough history or SPY can't be fetched, returns null and the UI degrades to "—".
//
// Deposits/withdrawals: no broker transfer ledger exists in this app, so external cash flows are
// INFERRED per snapshot gap (deposits +, withdrawals −, paper resets, ACH). See cash-flows.ts.
//
// Multi-period time-weighted return (TWR) — the GIPS-style method the owner described:
//   Split the overall window into back-to-back sub-periods at each deposit/withdrawal.
//   Sub-period account growth = V_end / (V_start + flow_at_end)  (flow is the external cash
//   that lands on the end snapshot; 0 when no transfer that day).
//   Sub-period SPY growth = SPY_end / SPY_start over the same calendar dates.
//   Chain: overall = ∏(1 + r_i) − 1 for account and for SPY independently.
// So "$100 for 10 days then $10 for 100 days" weights each regime's market performance by
// geometric linking, not by simple (end−start−flows)/start which overweights the big balance.
//
// excessReturnPct = accountTWR − spyTWR (percentage points).

import { fetchDailyOHLC } from "./history";
// The external-cash-flow math lives in its own dependency-free module: the console's client
// components need it, and reaching it through this file dragged history.ts + the db barrel into
// the browser bundle. See the header of ./cash-flows for the full rationale.
import { inferExternalCashFlows, isoDate, round2 } from "./cash-flows";
import type {
  BenchmarkComparison,
  BenchmarkSeriesPoint,
  BenchmarkSubPeriod,
  EquityCurvePoint,
  FillEvent
} from "./types";

/**
 * Pure multi-period TWR normalization.
 *
 * Aligns equity with a date→close benchmark series, then walks every consecutive snapshot pair
 * (after the first date that has a SPY close). Each pair is one sub-period:
 *   - Account factor = equity_i / (equity_{i−1} + externalFlow_i)   [flow-neutral TWR]
 *   - SPY factor     = spy_i / spy_{i−1}                           [same calendar window]
 * Both indexes start at 100 and multiply by the factors (geometric chain).
 *
 * When `flowsByDate` is empty/undefined, account factor collapses to equity_i/equity_{i−1}
 * (plain equity growth) and SPY chain equals buy-and-hold over the full window.
 *
 * Returns null when either series has < 2 usable points. Exported for direct unit testing.
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

  // Build aligned (date, equity, spy) series starting at first date with a SPY close.
  const aligned: Array<{ date: string; equity: number; spy: number }> = [];
  for (const d of equityDates) {
    const eq = equityByDate.get(d)!;
    const spy = closeOnOrBefore(d);
    if (spy == null) continue;
    aligned.push({ date: d, equity: eq, spy });
  }
  if (aligned.length < 2) return null;

  const equityIndex: BenchmarkSeriesPoint[] = [];
  const benchmarkIndex: BenchmarkSeriesPoint[] = [];
  const subPeriods: BenchmarkSubPeriod[] = [];

  // Both series start at 100 on the first aligned date.
  let accountIndex = 100;
  let spyIndex = 100;
  equityIndex.push({ date: aligned[0].date, index: 100 });
  benchmarkIndex.push({ date: aligned[0].date, index: 100 });

  let flowsApplied = 0;
  let netExternalFlows = 0;

  for (let i = 1; i < aligned.length; i++) {
    const prev = aligned[i - 1]!;
    const cur = aligned[i]!;
    const flow = flowsByDate?.get(cur.date) ?? 0;

    // ── Account sub-period (flow-neutral TWR) ──────────────────────────────
    // V_end / (V_start + external_flow_at_end). Deposit (+): larger denominator so the
    // injected cash is not counted as a gain. Withdrawal (−): smaller denominator so the
    // cash leaving is not counted as a loss.
    let accountFactor = 1;
    if (flow !== 0) {
      const denominator = prev.equity + flow;
      if (denominator > 0) {
        accountFactor = cur.equity / denominator;
        flowsApplied += 1;
        netExternalFlows += flow;
      } else {
        // Flow wiped (or more than wiped) prior equity — rebase at 0% for this sub-period
        // rather than dividing by a non-positive base.
        accountFactor = 1;
        flowsApplied += 1;
        netExternalFlows += flow;
      }
    } else if (prev.equity > 0) {
      accountFactor = cur.equity / prev.equity;
    }

    // ── SPY sub-period over the same calendar dates ────────────────────────
    // Geometric product of these factors = SPY_end/SPY_start over the full window, but we
    // still step them alongside account segments so each deposit/withdrawal boundary is an
    // explicit back-to-back sub-period (and the chart indexes share the same knots).
    const spyFactor = prev.spy > 0 ? cur.spy / prev.spy : 1;

    accountIndex *= accountFactor;
    spyIndex *= spyFactor;

    equityIndex.push({ date: cur.date, index: round2(accountIndex) });
    benchmarkIndex.push({ date: cur.date, index: round2(spyIndex) });

    // Record every sub-period that either has a flow or is a material market move — and always
    // when a flow lands, so the UI can show "between transfers" segments. Snap quiet flat days
    // into coarser segments? Keep every step for honesty; callers may aggregate.
    subPeriods.push({
      startDate: prev.date,
      endDate: cur.date,
      startEquity: round2(prev.equity),
      endEquity: round2(cur.equity),
      externalFlow: round2(flow),
      accountReturnPct: round2((accountFactor - 1) * 100),
      benchmarkReturnPct: round2((spyFactor - 1) * 100)
    });
  }

  if (equityIndex.length < 2) return null;

  const accountReturnPct = round2(accountIndex - 100);
  const benchmarkReturnPct = round2(spyIndex - 100);
  const flowsDetected = flowsApplied > 0 || Math.abs(netExternalFlows) >= 0.01;

  // Coalesce consecutive zero-flow flat sub-periods for a readable segment list: merge runs of
  // steps that have no external flow into one segment from first to last date (sum isn't needed —
  // recompute factors from endpoints). Keep every flow boundary as a hard cut.
  const coalesced = coalesceSubPeriods(subPeriods);

  return {
    equityIndex,
    benchmarkIndex,
    accountReturnPct,
    benchmarkReturnPct,
    excessReturnPct: round2(accountReturnPct - benchmarkReturnPct),
    startDate: aligned[0].date,
    endDate: equityIndex[equityIndex.length - 1].date,
    points: equityIndex.length,
    benchmarkSymbol,
    subPeriods: coalesced,
    ...(flowsDetected
      ? { cashFlowAdjusted: true, netExternalFlows: round2(netExternalFlows) }
      : { cashFlowAdjusted: false })
  };
}

/**
 * Merge consecutive sub-periods that have no external flow into single segments so the
 * UI shows one row per capital regime (between deposits/withdrawals), not one row per snapshot.
 * Periods with a non-zero externalFlow always start a new segment (the flow sits on endDate).
 */
export function coalesceSubPeriods(periods: BenchmarkSubPeriod[]): BenchmarkSubPeriod[] {
  if (periods.length === 0) return [];
  const out: BenchmarkSubPeriod[] = [];
  let acc: BenchmarkSubPeriod | null = null;
  let accAccountFactor = 1;
  let accSpyFactor = 1;

  const flush = () => {
    if (!acc) return;
    out.push({
      ...acc,
      accountReturnPct: round2((accAccountFactor - 1) * 100),
      benchmarkReturnPct: round2((accSpyFactor - 1) * 100)
    });
    acc = null;
    accAccountFactor = 1;
    accSpyFactor = 1;
  };

  for (const p of periods) {
    const aFactor = 1 + p.accountReturnPct / 100;
    const sFactor = 1 + p.benchmarkReturnPct / 100;
    const hasFlow = Math.abs(p.externalFlow) >= 0.01;

    if (!acc) {
      acc = { ...p };
      accAccountFactor = aFactor;
      accSpyFactor = sFactor;
      if (hasFlow) flush();
      continue;
    }

    // Extend the open no-flow run.
    if (!hasFlow && Math.abs(acc.externalFlow) < 0.01) {
      acc.endDate = p.endDate;
      acc.endEquity = p.endEquity;
      accAccountFactor *= aFactor;
      accSpyFactor *= sFactor;
      continue;
    }

    // Flow boundary (on this period or we already had a flow pending): close prior, start new.
    flush();
    acc = { ...p };
    accAccountFactor = aFactor;
    accSpyFactor = sFactor;
    if (hasFlow) flush();
  }
  flush();
  return out;
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
