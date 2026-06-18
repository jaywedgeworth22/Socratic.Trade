/**
 * Cboe delayed index quotes (free, no API key) via the public CDN. We pull the two
 * options-implied risk gauges FRED does not carry:
 *   - SKEW: the cost of tail (crash) hedging; ~100 = normal, >135–145 = elevated tail-risk pricing.
 *   - VVIX: the volatility of VIX itself; high = uncertainty about volatility, often near turning points.
 * (VIX / VIX3M already come from FRED.) Market-wide, daily. Honest: a failed fetch omits the field.
 */

const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/quotes";

export interface CboeVolStats {
  skew?: number;
  vvix?: number;
  asOf?: string;
}

async function fetchCboeQuote(symbol: string): Promise<number | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${CBOE_BASE}/${symbol}.json`, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { current_price?: unknown } };
    const px = json?.data?.current_price;
    return typeof px === "number" && Number.isFinite(px) && px > 0 ? Math.round(px * 100) / 100 : undefined;
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}

export async function fetchCboeVolStats(): Promise<CboeVolStats> {
  const [skew, vvix] = await Promise.all([fetchCboeQuote("_SKEW"), fetchCboeQuote("_VVIX")]);
  const out: CboeVolStats = {};
  if (skew !== undefined) out.skew = skew;
  if (vvix !== undefined) out.vvix = vvix;
  if (Object.keys(out).length > 0) out.asOf = new Date().toISOString().split("T")[0];
  return out;
}
