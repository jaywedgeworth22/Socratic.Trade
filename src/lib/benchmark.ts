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

import { resolveExternalCashFlows } from "./broker-cash-flows";
import type { AlpacaAccountActivity } from "./alpaca-account-insights";
import { fetchDailyOHLC } from "./history";
// The external-cash-flow math lives in its own dependency-free module: the console's client
// components need it, and reaching it through this file dragged history.ts + the db barrel into
// the browser bundle. See the header of ./cash-flows for the full rationale.
import { inferExternalCashFlows, isInferredFlowUnverified, isoDate, round2 } from "./cash-flows";
import type {
  BenchmarkComparison,
  BenchmarkSeriesPoint,
  BenchmarkSubPeriod,
  BenchmarkUnavailability,
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
  const unverifiedFlows: Array<{ date: string; amount: number }> = [];

  for (let i = 1; i < aligned.length; i++) {
    const prev = aligned[i - 1]!;
    const cur = aligned[i]!;
    let flow = flowsByDate?.get(cur.date) ?? 0;

    // Sanity bound (#2557): an inferred transfer must reconcile against its own sub-period's
    // equity delta. A flow that fails is UNVERIFIED — keep it visible on the sub-period row,
    // but compute this segment as if no transfer happened (raw equity growth) so a phantom
    // "withdrawal" can never mint fake TWR.
    const inferredFlow = flow;
    let flowUnverified = false;
    if (flow !== 0 && isInferredFlowUnverified(flow, prev.equity, cur.equity)) {
      unverifiedFlows.push({ date: cur.date, amount: round2(flow) });
      flowUnverified = true;
      flow = 0;
    }

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
      // An unverified flow keeps its inferred amount on the row (owner review), even though
      // the return math above ignored it.
      externalFlow: round2(inferredFlow),
      accountReturnPct: round2((accountFactor - 1) * 100),
      benchmarkReturnPct: round2((spyFactor - 1) * 100),
      ...(flowUnverified ? { flowUnverified: true } : {})
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
      : { cashFlowAdjusted: false }),
    ...(unverifiedFlows.length > 0 ? { unverifiedFlows } : {})
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

/** Result of the SPY comparison with an honest "why not" when it cannot be computed. */
export interface SpyBenchmarkResult {
  comparison: BenchmarkComparison | null;
  /** Present whenever `comparison` is null, naming the reason (feed failure vs young account). */
  unavailable?: BenchmarkUnavailability;
}

/** Calendar-day lag allowed between the last benchmark close and the account window's end before
 *  the series counts as stale (covers weekends/holidays + a same-day snapshot vs yesterday's close). */
export const BENCHMARK_STALE_GRACE_DAYS = 5;

/**
 * Pure staleness gate (#2557): a benchmark series whose last close predates the account window's
 * end by more than the grace period would map every later account date onto one frozen close —
 * SPY "0.00%" for every sub-period, and "vs SPY" silently re-printing the account number. That is
 * a dead feed, not a flat market. Returns the unavailability, or null when the series is usable.
 * Exported for direct unit testing.
 */
export function assessBenchmarkSeries(
  closes: Array<{ date: string; close: number }>,
  firstEquityDate: string,
  lastEquityDate: string,
  benchmarkSymbol = "SPY",
  seriesSource?: string
): BenchmarkUnavailability | null {
  const valid = closes.filter((c) => Number.isFinite(c.close) && c.close > 0);
  if (valid.length < 2) {
    return { reason: "no-bars", detail: `${benchmarkSymbol} history returned ${valid.length} usable close(s)` };
  }
  let lastCloseDate = valid[0].date;
  for (const c of valid) if (c.date > lastCloseDate) lastCloseDate = c.date;
  const lagMs = Date.parse(lastEquityDate) - Date.parse(lastCloseDate);
  if (Number.isFinite(lagMs) && lagMs > BENCHMARK_STALE_GRACE_DAYS * 86_400_000) {
    const source = seriesSource ? ` (source: ${seriesSource})` : "";
    return {
      reason: "stale-series",
      detail: `${benchmarkSymbol} closes end ${lastCloseDate}${source}; account window runs ${firstEquityDate} → ${lastEquityDate}`
    };
  }
  return null;
}

/**
 * Fetch SPY daily closes and compare them to the account equity curve. userId scopes the history
 * cache (consent-pooled). Optional `fills` (the same source's recorded fills) enable external
 * cash-flow inference so the account line is deposit/withdrawal-aware (TWR). Never throws into
 * the dashboard path; `comparison` is null on any failure, with `unavailable.reason` saying why —
 * feed failures (fetch-failed / no-bars / stale-series) are distinguished from the ordinary
 * young-account insufficient-history state so the UI can render a first-class "benchmark
 * unavailable" state instead of a fake 0.00% comparison.
 *
 * Synthetic fill-only curves (no real portfolio snapshots) are refused — those start at a fake
 * $100 equity base and are not comparable to SPY for an account holding real capital.
 */
export async function computeSpyBenchmarkDetailed(
  equityCurve: EquityCurvePoint[],
  userId?: string,
  now: number = Date.now(),
  fills?: FillEvent[],
  brokerActivities?: AlpacaAccountActivity[]
): Promise<SpyBenchmarkResult> {
  if (!equityCurve || equityCurve.length < 2) {
    return { comparison: null, unavailable: { reason: "insufficient-history" } };
  }
  // Defense in depth against fabricated-equity curves (getPerformanceSummary no longer builds one
  // when there are no persisted portfolio snapshots, but this filter stays as a second guard for
  // any caller that hands in a hand-built curve without cash/positionsValue). IMPORTANT: do not
  // let a single live tip (which has cash) "upgrade" a curve with no real snapshots into a real
  // TWR — that made $100-base fill curves + $100k tip read as +tens of % "account return" on
  // paper/sandbox accounts. Require ≥2 real snapshot points.
  const realCurve = equityCurve.filter(
    (p) => typeof p.cash === "number" || typeof p.positionsValue === "number"
  );
  if (realCurve.length < 2) {
    return { comparison: null, unavailable: { reason: "insufficient-history" } };
  }
  // Prefer the real-snapshot sub-curve (includes a live tip when present).
  equityCurve = realCurve;
  let bars;
  try {
    bars = await fetchDailyOHLC("SPY", now, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { comparison: null, unavailable: { reason: "fetch-failed", detail: message.slice(0, 200) } };
  }
  if (!bars || bars.length < 2) {
    return {
      comparison: null,
      unavailable: { reason: "no-bars", detail: `SPY history cascade returned ${bars?.length ?? 0} bar(s)` }
    };
  }
  const closes = bars
    .map((b) => ({ date: isoDate(b.time), close: b.close }))
    .filter((b): b is { date: string; close: number } => b.date != null && Number.isFinite(b.close));

  // Staleness gate BEFORE computing: a series frozen before the account window would print
  // 0.00% for every sub-period (the live 2026-08-06 failure — stale local bars fallback).
  const equityDates = equityCurve
    .map((p) => isoDate(p.timestamp))
    .filter((d): d is string => d != null)
    .sort();
  if (equityDates.length >= 2) {
    const lastBar = bars[bars.length - 1];
    const seriesSource = typeof lastBar?.source === "string" ? lastBar.source : undefined;
    const stale = assessBenchmarkSeries(closes, equityDates[0], equityDates[equityDates.length - 1], "SPY", seriesSource);
    if (stale) return { comparison: null, unavailable: stale };
  }

  const { flows, source } = resolveExternalCashFlows({ equityCurve, fills, brokerActivities });
  const comparison = normalizeAgainstBenchmark(equityCurve, closes, "SPY", flows.size > 0 ? flows : undefined);
  if (!comparison) return { comparison: null, unavailable: { reason: "insufficient-overlap" } };
  if (source === "broker" && flows.size > 0) comparison.cashFlowAdjusted = true;
  return { comparison };
}

/** Back-compat wrapper: the comparison alone (null on any failure). Prefer the detailed variant. */
export async function computeSpyBenchmark(
  equityCurve: EquityCurvePoint[],
  userId?: string,
  now: number = Date.now(),
  fills?: FillEvent[],
  brokerActivities?: AlpacaAccountActivity[]
): Promise<BenchmarkComparison | null> {
  return (await computeSpyBenchmarkDetailed(equityCurve, userId, now, fills, brokerActivities)).comparison;
}
