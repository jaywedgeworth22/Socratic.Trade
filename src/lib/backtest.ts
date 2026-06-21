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
