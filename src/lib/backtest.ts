// Information-coefficient (IC) backtest harness over the persisted `signal_snapshot`
// audit data. Addresses the "factor weights are unvalidated, no backtest" review
// finding: instead of trusting the hand-tuned DEFAULT_SCORING_WEIGHTS, this measures
// each factor sub-score's realized predictive power (rank IC vs forward return) from
// the deterministic evidence we already store at every decision.
//
// Design split (intentional, mirrors counterfactual-learning.ts):
//   - buildFactorObservations is the ONLY IO function. It reads the audit rows and an
//     injectable OHLC fetcher to compute matured forward returns. Never fabricates a
//     price: no matured bar → the observation is omitted (same posture as the
//     counterfactual materializer — unresolved, not invented).
//   - computeFactorICs and deriveWeightsFromICs are PURE and Date.now()-free, so they
//     are deterministic and unit-testable with in-memory fixtures (no db, no network).

import { listSignalSnapshotAuditAfter, type SignalSnapshotAuditRow } from "./db";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";
import { DEFAULT_SCORING_WEIGHTS } from "./defaults";
import type { MarketFactor, MarketFactorBreakdown, ScoringWeights } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_HORIZON_DAYS = 5;
const DEFAULT_AUDIT_LIMIT = 500;

/** The eight scored factors, derived from the canonical weight keys (single source of truth). */
export const MARKET_FACTORS = Object.keys(DEFAULT_SCORING_WEIGHTS) as MarketFactor[];

/** Injectable daily-OHLC fetcher; matches `fetchDailyOHLC`'s signature for drop-in defaulting. */
export type BacktestOHLCFetcher = (symbol: string, now?: number, userId?: string) => Promise<OHLCBar[] | null>;

/**
 * One resolved per-candidate observation: the factor sub-scores recorded at decision
 * time and the realized N-business-day forward return computed from stored `refPrice`
 * (entry) to the first daily close on/after entryDate + N business days (exit).
 */
export interface FactorObservation {
  /** Snapshot business day (YYYY-MM-DD) — the cross-sectional grouping key for IC. */
  date: string;
  symbol: string;
  /** Factor sub-scores at decision time (from `factorBreakdown`, excluding weightedTotal). */
  subScores: Record<MarketFactor, number>;
  /** Realized forward return as a fraction (e.g. 0.05 = +5%). */
  forwardReturn: number;
}

/** Averaged cross-sectional rank IC for one factor across all snapshot dates. */
export interface FactorIC {
  factor: MarketFactor;
  /** Mean per-date Spearman rank IC (NaN-free; 0 when no date had ≥2 usable names). */
  ic: number;
  /** Number of snapshot dates that contributed an IC (had ≥2 names with finite values). */
  n: number;
}

export interface BuildFactorObservationsOptions {
  /** Forward-return horizon in business days. Default 5. */
  horizonDays?: number;
  /** Max audit rows to scan. Default 500. */
  auditLimit?: number;
  /** Reference "now" passed to the fetcher (kept out of the pure path). Default Date.now(). */
  now?: number;
  /** Injectable OHLC fetcher; defaults to fetchDailyOHLC. */
  fetchOHLC?: BacktestOHLCFetcher;
}

interface SignalSnapshotPayload {
  runId?: string;
  asOf?: string;
  signals?: Array<{
    symbol?: string;
    refPrice?: number;
    factorBreakdown?: MarketFactorBreakdown;
    asOf?: string;
  }>;
}

/**
 * THE ONLY IO FUNCTION. Reads `signal_snapshot` audit rows for `userId` and, for every
 * candidate that carries both a `refPrice` and a `factorBreakdown`, computes the
 * matured N-business-day forward return (entry = stored refPrice; exit = first daily
 * close on/after entryDate + N business days). Returns one {date, symbol, subScores,
 * forwardReturn} per resolvable candidate and SKIPS anything unresolved (no refPrice,
 * no breakdown, no matured exit bar) — it never fabricates a price.
 */
export async function buildFactorObservations(
  userId: string = "local",
  options: BuildFactorObservationsOptions = {}
): Promise<FactorObservation[]> {
  const now = options.now ?? Date.now();
  const horizonDays = boundedInteger(options.horizonDays ?? DEFAULT_HORIZON_DAYS, 1, 252, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit ?? DEFAULT_AUDIT_LIMIT, 1, 5000, DEFAULT_AUDIT_LIMIT);
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;

  const rows = listSignalSnapshotAuditAfter(userId, undefined, auditLimit);
  const observations: FactorObservation[] = [];
  // Cache bars per symbol across the whole scan; null means "fetched, none available".
  const barsBySymbol = new Map<string, OHLCBar[] | null>();

  for (const row of rows) {
    const parsed = parseSnapshot(row);
    if (!parsed) continue;
    const { snapshotDate, signals } = parsed;
    const targetDate = targetBusinessDate(snapshotDate, horizonDays);

    for (const signal of signals) {
      const symbol = normalizeSymbol(signal.symbol ?? "");
      const refPrice = positiveNumber(signal.refPrice);
      const subScores = extractSubScores(signal.factorBreakdown);
      if (!symbol || !refPrice || !subScores) continue;

      let bars = barsBySymbol.get(symbol);
      if (bars === undefined) {
        bars = await fetchOHLC(symbol, now, userId);
        barsBySymbol.set(symbol, bars);
      }
      const exit = bars ? selectExitClose(bars, targetDate) : undefined;
      if (exit === undefined) continue; // unresolved → omit, never invent

      observations.push({
        date: snapshotDate,
        symbol,
        subScores,
        forwardReturn: (exit - refPrice) / refPrice
      });
    }
  }

  return observations;
}

/**
 * PURE. Cross-sectional Spearman rank IC between each factor sub-score and forward
 * return, computed PER snapshot date and then averaged across dates. Tie-aware:
 * ties share their average rank and the correlation is the Pearson correlation of
 * those average ranks (the standard tie-corrected Spearman). Date.now()-free.
 *
 * Returns one entry per market factor (stable order). A factor's `ic` is the mean of
 * its per-date ICs; `n` is how many dates contributed (a date contributes only if it
 * has ≥2 names with finite sub-score AND finite forward return AND non-degenerate
 * variance in both after ranking).
 */
export function computeFactorICs(observations: FactorObservation[]): FactorIC[] {
  const byDate = new Map<string, FactorObservation[]>();
  for (const obs of observations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }

  return MARKET_FACTORS.map((factor) => {
    let sum = 0;
    let dates = 0;
    for (const group of byDate.values()) {
      const scores: number[] = [];
      const returns: number[] = [];
      for (const obs of group) {
        const s = obs.subScores[factor];
        const r = obs.forwardReturn;
        if (Number.isFinite(s) && Number.isFinite(r)) {
          scores.push(s);
          returns.push(r);
        }
      }
      if (scores.length < 2) continue;
      const ic = spearmanRankIC(scores, returns);
      if (ic === undefined) continue; // degenerate (zero variance after ranking)
      sum += ic;
      dates += 1;
    }
    return { factor, ic: dates > 0 ? sum / dates : 0, n: dates };
  });
}

/**
 * PURE. Per-factor IC — an alias for `computeFactorICs` that returns the same per-factor
 * IC and sample-size data. Accepts the same `FactorObservation[]` produced by
 * `buildFactorObservations`. Exported under the singular name for callers that prefer it.
 *
 * @returns One entry per market factor in canonical order: { factor, ic, n }
 */
export function computePerFactorIC(
  observations: FactorObservation[]
): { factor: MarketFactor; ic: number; n: number }[] {
  return computeFactorICs(observations);
}

/**
 * PURE. Derive scoring weights from per-factor ICs with a minimum sample-size gate.
 * - Factors with `n < minN` are excluded (insufficient data) and receive their DEFAULT weight.
 * - Negative ICs are floored to 0.
 * - Positive ICs are scaled so their sum matches the sum of DEFAULT_SCORING_WEIGHTS (~8.6)
 *   rather than 1.0, so the derived weights are in the same magnitude as the hand-tuned defaults.
 * - If no factor clears both the minN gate AND has a positive IC, returns DEFAULT_SCORING_WEIGHTS.
 *
 * @param perFactorIC  Output of `computePerFactorIC` or `computeFactorICs`.
 * @param minN         Minimum number of contributing snapshot dates to use a factor's IC. Default 20.
 * @returns Partial<ScoringWeights> — factors below minN carry their DEFAULT value.
 */
export function deriveWeightsFromIC(
  perFactorIC: { factor: MarketFactor; ic: number; n: number }[],
  minN: number = 20
): Partial<ScoringWeights> {
  const defaultSum = MARKET_FACTORS.reduce((s, f) => s + DEFAULT_SCORING_WEIGHTS[f], 0);

  const qualified = new Map<MarketFactor, number>();
  let positiveTotal = 0;
  for (const { factor, ic, n } of perFactorIC) {
    if (n >= minN && Number.isFinite(ic) && ic > 0) {
      qualified.set(factor, ic);
      positiveTotal += ic;
    }
  }

  // If nothing qualifies, fall back to defaults entirely.
  if (positiveTotal <= 0) return { ...DEFAULT_SCORING_WEIGHTS };

  const out: Partial<ScoringWeights> = {};
  for (const factor of MARKET_FACTORS) {
    if (qualified.has(factor)) {
      // Scale so positive ICs sum to the same total as the defaults.
      out[factor] = (qualified.get(factor)! / positiveTotal) * defaultSum;
    } else {
      // Below minN (or negative IC) → keep default weight unchanged.
      out[factor] = DEFAULT_SCORING_WEIGHTS[factor];
    }
  }
  return out;
}

/**
 * PURE. Turns measured ICs into a normalized weight vector: floor each negative IC at
 * 0, then normalize the positives to sum to 1. If every IC is ≤ 0 (no factor showed
 * positive predictive power), fall back to `fallbackWeights` (DEFAULT_SCORING_WEIGHTS)
 * unchanged. Date.now()-free.
 */
export function deriveWeightsFromICs(
  ics: FactorIC[],
  fallbackWeights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ScoringWeights {
  const floored = new Map<MarketFactor, number>();
  let total = 0;
  for (const { factor, ic } of ics) {
    const positive = Number.isFinite(ic) && ic > 0 ? ic : 0;
    floored.set(factor, positive);
    total += positive;
  }

  if (total <= 0) return { ...fallbackWeights };

  // Start from a full key set so every ScoringWeights field is present even if an IC
  // entry was missing for some factor (defensive — missing factor → 0 weight).
  const out = {} as ScoringWeights;
  for (const factor of MARKET_FACTORS) {
    out[factor] = (floored.get(factor) ?? 0) / total;
  }
  return out;
}

// --- internal helpers (pure unless noted) -------------------------------------------

function parseSnapshot(row: SignalSnapshotAuditRow): { snapshotDate: string; signals: NonNullable<SignalSnapshotPayload["signals"]> } | undefined {
  const payload = row.payload as SignalSnapshotPayload | undefined;
  if (!payload || !Array.isArray(payload.signals)) return undefined;
  // Prefer the snapshot's own asOf; fall back to the audit row's createdAt.
  const snapshotDate = toBusinessDay(payload.asOf) ?? toBusinessDay(row.createdAt);
  if (!snapshotDate) return undefined;
  return { snapshotDate, signals: payload.signals };
}

/** Sub-scores from a factorBreakdown, excluding `weightedTotal`. Undefined if unusable. */
function extractSubScores(breakdown?: MarketFactorBreakdown): Record<MarketFactor, number> | undefined {
  if (!breakdown) return undefined;
  const out = {} as Record<MarketFactor, number>;
  let any = false;
  for (const factor of MARKET_FACTORS) {
    const value = Number(breakdown[factor]);
    if (Number.isFinite(value)) {
      out[factor] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** Mirror of counterfactual-learning's convention: snapshot day + N calendar days, ISO date. */
function targetBusinessDate(snapshotDate: string, horizonDays: number): string {
  const time = Date.parse(snapshotDate);
  if (!Number.isFinite(time)) return snapshotDate;
  return new Date(time + horizonDays * DAY_MS).toISOString().slice(0, 10);
}

/** First daily close on/after `targetDate`. Undefined → not matured (never fabricate). */
function selectExitClose(bars: OHLCBar[], targetDate: string): number | undefined {
  const exit = bars
    .map((bar) => ({ date: toBusinessDay(bar.time), close: positiveNumber(bar.close) }))
    .filter((bar): bar is { date: string; close: number } => Boolean(bar.date && bar.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .find((bar) => bar.date >= targetDate);
  return exit?.close;
}

/**
 * Tie-corrected Spearman rank IC: Pearson correlation of the average ranks of `xs` and
 * `ys`. Returns undefined when either side has zero variance after ranking (correlation
 * undefined). Assumes xs.length === ys.length >= 2.
 */
function spearmanRankIC(xs: number[], ys: number[]): number | undefined {
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  return pearson(rx, ry);
}

/** Average ranks (1-based), ties sharing the mean of the positions they span. Pure. */
function averageRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    // positions i..j (0-based) → ranks (i+1)..(j+1); average them
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[indexed[k].index] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation; undefined if either series has zero variance. Pure. */
function pearson(xs: number[], ys: number[]): number | undefined {
  const n = xs.length;
  if (n < 2) return undefined;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return undefined;
  return cov / Math.sqrt(vx * vy);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

// =============================================================================
// Walk-forward OOS validation
// =============================================================================

/** A single point on the cumulative equity curve. */
export interface EquityCurvePoint {
  date: string;
  nNames: number;
  /** Mean net return of the top-K names on this date (cost+tax adjusted). */
  periodReturn: number;
  /** SPY forward return over the same horizon (null = SPY data unavailable). */
  benchmarkReturn: number | null;
  /** Compounded strategy return since the first OOS date (fraction; 0.12 = +12%). */
  cumulativeReturn: number;
  /** Compounded SPY return since first OOS date (null if no SPY data). */
  benchmarkCumulativeReturn: number | null;
}

/** Options for a full walk-forward OOS run — extends the observation-build options. */
export interface OOSRunOptions extends BuildFactorObservationsOptions {
  /** Fraction of unique snapshot dates used for training IC derivation. Default 0.7. */
  trainFraction?: number;
  /** Estimated total round-trip transaction cost in basis points. Default 20 (10 bps/leg). */
  costRoundTripBps?: number;
  /** Short-term capital-gains tax rate applied to positive OOS returns. Default 0.24. */
  taxRate?: number;
  /** Number of top-ranked names per date included in the simulated long portfolio. Default 3. */
  topK?: number;
  /**
   * Candidate scoring weights to validate OOS — e.g. a tuning proposal's proposed weights merged
   * over the current policy. When supplied, the result includes `oosICCandidate`: the OOS composite
   * IC of THESE weights. This is what lets the tuning gate validate the actual PROPOSED weights
   * rather than the data-derived IC weights (which `oosIC` measures).
   */
  candidateWeights?: ScoringWeights;
  /**
   * Baseline weights the candidate is compared against — e.g. the current policy weights (the
   * status quo a proposal would replace). When supplied, the result includes `oosICBaseline`.
   */
  baselineWeights?: ScoringWeights;
}

/** Full walk-forward OOS validation result. */
export interface OOSResult {
  trainObservations: number;
  testObservations: number;
  trainDates: number;
  testDates: number;
  trainICs: FactorIC[];
  icWeights: ScoringWeights;
  /** Mean cross-sectional IC of the IC-weighted composite score on OOS dates. */
  oosIC: number;
  /** OOS composite IC of `options.candidateWeights` (the proposed weights), when supplied. */
  oosICCandidate?: number;
  /** OOS composite IC of `options.baselineWeights` (the status-quo weights), when supplied. */
  oosICBaseline?: number;
  /**
   * OOS IC information ratio (mean / sample-std of per-date ICs).
   * Values > 0.5 are conventionally considered evidence of a real signal.
   */
  oosICIR: number;
  /** OOS composite IC using the default hand-tuned weights — baseline to beat. */
  oosICDefault: number;
  equityCurve: EquityCurvePoint[];
  /** Annualized strategy return over the OOS period (null when <2 OOS dates). */
  annualizedReturn: number | null;
  /** Annualized SPY return over same period (null when no SPY data). */
  benchmarkAnnualizedReturn: number | null;
  /** annualizedReturn − benchmarkAnnualizedReturn. */
  activeReturn: number | null;
  /** Annualized Sharpe ratio of the OOS strategy (null when all periods equal). */
  sharpeRatio: number | null;
  /** Max peak-to-trough drawdown of the OOS equity curve (expressed as %). */
  maxDrawdownPct: number;
  note: string;
}

/**
 * PURE. Chronological walk-forward split: the first `trainFraction` of unique sorted snapshot
 * dates become the train set; the rest become the test set. Order within each group is preserved.
 */
export function splitWalkForward(
  observations: FactorObservation[],
  trainFraction: number = 0.7
): { train: FactorObservation[]; test: FactorObservation[] } {
  const dates = [...new Set(observations.map((o) => o.date))].sort();
  if (dates.length < 2) return { train: observations, test: [] };
  const cutIdx = Math.max(1, Math.floor(dates.length * trainFraction));
  const trainDates = new Set(dates.slice(0, cutIdx));
  return {
    train: observations.filter((o) => trainDates.has(o.date)),
    test: observations.filter((o) => !trainDates.has(o.date))
  };
}

/**
 * PURE. Adjust forward returns for round-trip transaction cost and short-term tax drag.
 * Cost is always debited (positive or negative gross return). Tax is applied only to
 * positive after-cost returns: net = (gross − cost) × (1 − taxRate).
 */
export function adjustReturns(
  observations: FactorObservation[],
  options: { costRoundTripBps?: number; taxRate?: number } = {}
): FactorObservation[] {
  const costFrac = (options.costRoundTripBps ?? 20) / 1e4;
  const taxRate = options.taxRate ?? 0.24;
  return observations.map((obs) => {
    const afterCost = obs.forwardReturn - costFrac;
    const taxDrag = afterCost > 0 ? afterCost * taxRate : 0;
    return { ...obs, forwardReturn: afterCost - taxDrag };
  });
}

/** PURE. Weighted-sum composite score for one observation. */
function compositeScore(obs: FactorObservation, weights: ScoringWeights): number {
  let score = 0;
  for (const factor of MARKET_FACTORS) {
    score += (weights[factor] ?? 0) * (obs.subScores[factor] ?? 0);
  }
  return score;
}

/**
 * PURE. Compute the IC of a single composite (weighted-sum) score column vs forward return,
 * per date, then average across dates. Returns meanIC and ICIR (mean / sample-std), which
 * is the primary signal-quality summary for a composite predictor.
 */
export function computeCompositeIC(
  observations: FactorObservation[],
  weights: ScoringWeights
): { meanIC: number; icIR: number } {
  const byDate = new Map<string, FactorObservation[]>();
  for (const obs of observations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }

  const perDateICs: number[] = [];
  for (const group of byDate.values()) {
    const scores: number[] = [];
    const returns: number[] = [];
    for (const obs of group) {
      const s = compositeScore(obs, weights);
      const r = obs.forwardReturn;
      if (Number.isFinite(s) && Number.isFinite(r)) {
        scores.push(s);
        returns.push(r);
      }
    }
    if (scores.length < 2) continue;
    const ic = spearmanRankIC(scores, returns);
    if (ic !== undefined) perDateICs.push(ic);
  }

  if (perDateICs.length === 0) return { meanIC: 0, icIR: 0 };
  const n = perDateICs.length;
  const mean = perDateICs.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { meanIC: mean, icIR: 0 };
  const sampleVar = perDateICs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(sampleVar);
  return { meanIC: mean, icIR: std > 0 ? mean / std : 0 };
}

/**
 * PURE. Build an equity curve: on each OOS date (chronological), score all names with
 * `weights`, select the top-K, compute their mean net return as the period return, and
 * compound cumulatively. Benchmark (SPY) returns are compounded in parallel.
 *
 * Note: overlapping holding periods (e.g. daily snapshots with a 5-day horizon) are
 * treated as independent cross-sections per standard IC-backtest convention — each date
 * represents one equal-weighted investment decision, not a physically non-overlapping trade.
 */
export function buildEquityCurve(
  oosObservations: FactorObservation[],
  weights: ScoringWeights,
  spyReturnByDate: Map<string, number>,
  topK: number = 3
): EquityCurvePoint[] {
  const byDate = new Map<string, FactorObservation[]>();
  for (const obs of oosObservations) {
    const bucket = byDate.get(obs.date);
    if (bucket) bucket.push(obs);
    else byDate.set(obs.date, [obs]);
  }

  const sortedDates = [...byDate.keys()].sort();
  const curve: EquityCurvePoint[] = [];
  let cumStrategy = 1.0;
  let cumBenchmark: number | null = null;

  for (const date of sortedDates) {
    const group = byDate.get(date)!;
    const scored = group
      .map((obs) => ({ obs, score: compositeScore(obs, weights) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((a, b) => b.score - a.score);

    const topGroup = scored.slice(0, topK);
    if (topGroup.length === 0) continue;

    const periodReturn = topGroup.reduce((s, { obs }) => s + obs.forwardReturn, 0) / topGroup.length;
    const benchmarkReturn = spyReturnByDate.has(date) ? (spyReturnByDate.get(date) as number) : null;

    cumStrategy *= 1 + periodReturn;
    if (benchmarkReturn !== null) {
      cumBenchmark = (cumBenchmark ?? 1.0) * (1 + benchmarkReturn);
    }

    curve.push({
      date,
      nNames: topGroup.length,
      periodReturn,
      benchmarkReturn,
      cumulativeReturn: cumStrategy - 1,
      benchmarkCumulativeReturn: cumBenchmark !== null ? cumBenchmark - 1 : null
    });
  }

  return curve;
}

/**
 * NOT EXPORTED. Fetch SPY OHLC and compute forward returns for each supplied date.
 * Uses the same selectExitClose + targetBusinessDate logic as buildFactorObservations.
 * Returns an empty Map if SPY bars are unavailable.
 */
async function buildSpyReturnMap(
  dates: string[],
  horizonDays: number,
  now: number,
  fetchOHLC: BacktestOHLCFetcher
): Promise<Map<string, number>> {
  const spyBars = await fetchOHLC("SPY", now);
  if (!spyBars || spyBars.length === 0) return new Map();

  const result = new Map<string, number>();
  for (const date of dates) {
    const entryClose = selectExitClose(spyBars, date);
    if (entryClose === undefined) continue;
    const exitClose = selectExitClose(spyBars, targetBusinessDate(date, horizonDays));
    if (exitClose === undefined) continue;
    result.set(date, (exitClose - entryClose) / entryClose);
  }
  return result;
}

/**
 * IO. Walk-forward out-of-sample validation.
 *
 * 1. Builds factor observations from the `signal_snapshot` audit log.
 * 2. Splits chronologically: train (default 70%) / test (30%).
 * 3. Derives IC weights from the train period.
 * 4. Measures OOS composite IC + ICIR of those IC weights vs the test period.
 * 5. Compares against the default (hand-tuned) weights as a baseline.
 * 6. Builds a cost+tax-adjusted equity curve for the test period, with SPY benchmark.
 *
 * Returns null when fewer than 4 unique snapshot dates are available — insufficient
 * to perform a meaningful split.
 */
export async function runWalkForwardOOS(
  userId: string = "local",
  options: OOSRunOptions = {}
): Promise<OOSResult | null> {
  const now = options.now ?? Date.now();
  const horizonDays = boundedInteger(options.horizonDays ?? DEFAULT_HORIZON_DAYS, 1, 252, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit ?? DEFAULT_AUDIT_LIMIT, 1, 5000, DEFAULT_AUDIT_LIMIT);
  const trainFraction = Math.max(0.5, Math.min(0.9, options.trainFraction ?? 0.7));
  const topK = boundedInteger(options.topK ?? 3, 1, 20, 3);
  const costRoundTripBps = options.costRoundTripBps ?? 20;
  const taxRate = options.taxRate ?? 0.24;
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;

  const rawObservations = await buildFactorObservations(userId, { horizonDays, auditLimit, now, fetchOHLC });

  const uniqueDates = [...new Set(rawObservations.map((o) => o.date))].sort();
  if (uniqueDates.length < 4) return null;

  const { train, test } = splitWalkForward(rawObservations, trainFraction);
  if (train.length === 0 || test.length === 0) return null;

  const trainICs = computeFactorICs(train);
  const icWeights = deriveWeightsFromICs(trainICs);

  const adjustedTest = adjustReturns(test, { costRoundTripBps, taxRate });

  const { meanIC: oosIC, icIR: oosICIR } = computeCompositeIC(adjustedTest, icWeights);
  const { meanIC: oosICDefault } = computeCompositeIC(adjustedTest, DEFAULT_SCORING_WEIGHTS);
  // Validate the ACTUAL proposed/candidate weights (and the status-quo baseline) against the same
  // held-out test fold, so callers can gate on whether the candidate beats what's running today —
  // not on whether the data-derived IC weights beat default (which `oosIC` measures).
  const oosICCandidate = options.candidateWeights
    ? computeCompositeIC(adjustedTest, options.candidateWeights).meanIC
    : undefined;
  const oosICBaseline = options.baselineWeights
    ? computeCompositeIC(adjustedTest, options.baselineWeights).meanIC
    : undefined;

  const oosDates = [...new Set(adjustedTest.map((o) => o.date))];
  const spyReturnByDate = await buildSpyReturnMap(oosDates, horizonDays, now, fetchOHLC);

  const equityCurve = buildEquityCurve(adjustedTest, icWeights, spyReturnByDate, topK);

  let annualizedReturn: number | null = null;
  let benchmarkAnnualizedReturn: number | null = null;
  let activeReturn: number | null = null;
  let sharpeRatio: number | null = null;
  let maxDrawdownPct = 0;

  if (equityCurve.length >= 2) {
    const firstTs = Date.parse(equityCurve[0].date);
    const lastTs = Date.parse(equityCurve[equityCurve.length - 1].date);
    const calendarDays = Math.max(1, (lastTs - firstTs) / DAY_MS);
    const annualFactor = 252 / calendarDays;
    const last = equityCurve[equityCurve.length - 1];

    annualizedReturn = Math.pow(1 + last.cumulativeReturn, annualFactor) - 1;

    if (last.benchmarkCumulativeReturn !== null) {
      benchmarkAnnualizedReturn = Math.pow(1 + last.benchmarkCumulativeReturn, annualFactor) - 1;
      activeReturn = annualizedReturn - benchmarkAnnualizedReturn;
    }

    const rets = equityCurve.map((p) => p.periodReturn);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sampleVar = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
    const std = Math.sqrt(sampleVar);
    if (std > 0) sharpeRatio = (mean / std) * Math.sqrt(252 / horizonDays);

    let peak = 1.0;
    for (const pt of equityCurve) {
      const equity = 1 + pt.cumulativeReturn;
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
    maxDrawdownPct *= 100;
  }

  const trainDates = new Set(train.map((o) => o.date)).size;
  const testDates = new Set(adjustedTest.map((o) => o.date)).size;

  return {
    trainObservations: train.length,
    testObservations: adjustedTest.length,
    trainDates,
    testDates,
    trainICs,
    icWeights,
    oosIC,
    oosICIR,
    oosICDefault,
    oosICCandidate,
    oosICBaseline,
    equityCurve,
    annualizedReturn,
    benchmarkAnnualizedReturn,
    activeReturn,
    sharpeRatio,
    maxDrawdownPct,
    note: `Walk-forward: ${trainDates} train dates → IC weights; ${testDates} OOS dates (${costRoundTripBps}bps round-trip cost, ${Math.round(taxRate * 100)}% tax). Top-${topK} names/date.`
  };
}
