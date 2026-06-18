import { fetchCboeVolStats, type CboeVolStats } from "./cboe";
import { fetchCftcSpPositioning } from "./cftc";
import { fetchFamaFrenchFactors, type FamaFrenchFactors } from "./famafrench";

/**
 * Market-wide regime/sentiment signals from free, no-key sources — Cboe (options-implied
 * tail risk), CFTC (futures positioning), and Kenneth French (equity-factor regime). These
 * slow-moving signals frame single-name decisions, so they are fetched once and cached, then
 * handed to the LLM as one compact `marketSignals` block. Every sub-source is independent and
 * failure-tolerant: a source that is down simply drops out (never fabricated).
 */
export interface MarketSignals {
  /** Cboe SKEW index — tail-risk / crash-hedging demand (~100 normal, >135–145 elevated). */
  skew?: number;
  /** Cboe VVIX — volatility of VIX (uncertainty about volatility itself). */
  vvix?: number;
  /** E-mini S&P 500 large-speculator net contracts (+ long / − short). */
  cotSpNonCommNet?: number;
  /** …as a % of total open interest. */
  cotSpNonCommNetPctOI?: number;
  /** CFTC report date (weekly). */
  cotReportDate?: string;
  /** Trailing ~1-month cumulative equity-factor returns (%), from Kenneth French. */
  factors1m?: Partial<Record<"mktRf" | "smb" | "hml" | "mom", number>>;
  /** Latest factor observation date. */
  factorsAsOf?: string;
}

const CACHE_TTL_MS = 6 * 60 * 60_000; // these move daily/weekly; 6h is plenty
const cache: { expiresAt: number; data: MarketSignals | null } = { expiresAt: 0, data: null };

export async function getMarketSignals(): Promise<MarketSignals> {
  const now = nowMs();
  if (cache.data && cache.expiresAt > now) return cache.data;

  const [cboe, cot, ff] = await Promise.all([
    fetchCboeVolStats().catch((): CboeVolStats => ({})),
    fetchCftcSpPositioning().catch(() => undefined),
    fetchFamaFrenchFactors().catch((): FamaFrenchFactors => ({}))
  ]);

  const data: MarketSignals = {};
  if (typeof cboe.skew === "number") data.skew = cboe.skew;
  if (typeof cboe.vvix === "number") data.vvix = cboe.vvix;
  if (cot?.nonCommNet !== undefined) data.cotSpNonCommNet = cot.nonCommNet;
  if (cot?.nonCommNetPctOI !== undefined) data.cotSpNonCommNetPctOI = cot.nonCommNetPctOI;
  if (cot?.reportDate) data.cotReportDate = cot.reportDate;
  if (ff.factors1m) data.factors1m = ff.factors1m;
  if (ff.asOf) data.factorsAsOf = ff.asOf;

  cache.data = data;
  cache.expiresAt = now + CACHE_TTL_MS;
  return data;
}

// Isolated so the module stays testable; Date.now is fine at runtime here.
function nowMs(): number {
  return Date.now();
}
