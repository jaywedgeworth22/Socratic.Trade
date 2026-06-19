import { resolveApiKey } from "./db";

export interface MacroData {
  fedFundsRate: string;
  dgs3moTreasury: string;
  dgs2Treasury: string;
  dgs10Treasury: string;
  inflationExpectation10y: string; // 10Y breakeven — market-implied inflation
  cpiInflation: string;
  corePCE: string; // Fed's preferred inflation gauge (core PCE YoY)
  realGDPGrowth: string; // real GDP, annualized % (SAAR)
  unemploymentRate: string;
  initialClaims: string; // weekly initial jobless claims (labor-market pulse)
  m2MoneySupply: string;
  m2GrowthYoY: string;
  hyCreditSpread: string; // ICE BofA US high-yield OAS — credit risk appetite
  usdIndex: string; // broad trade-weighted USD index
  wtiOil: string; // WTI crude spot
  housingStarts: string;
  consumerSentiment: string;
  vix: string;
  vix3m: string; // 3-month VIX (for term structure)
  asOf: string;
}

const DEFAULT_MACRO: MacroData = {
  fedFundsRate: "5.25%",
  dgs3moTreasury: "5.10%",
  dgs2Treasury: "4.60%",
  dgs10Treasury: "4.20%",
  inflationExpectation10y: "2.30%",
  cpiInflation: "3.10%",
  corePCE: "2.80%",
  realGDPGrowth: "2.00%",
  unemploymentRate: "3.90%",
  initialClaims: "220K",
  m2MoneySupply: "20.8T",
  m2GrowthYoY: "2.50%",
  hyCreditSpread: "3.20%",
  usdIndex: "121.00",
  wtiOil: "$75.00",
  housingStarts: "1.3M",
  consumerSentiment: "75.0",
  vix: "15.00",
  vix3m: "17.00",
  asOf: new Date().toISOString().split("T")[0]
};

const cache: { expiresAt: number; data: MacroData | null } = {
  expiresAt: 0,
  data: null
};

const CACHE_TTL_MS = 24 * 60 * 60_000; // Macro data moves slowly; cache 24h

export async function fetchMacroData(userId?: string): Promise<MacroData> {
  const now = Date.now();
  if (cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  const apiKey = resolveApiKey("fred", userId);
  if (!apiKey) {
    return DEFAULT_MACRO;
  }

  try {
    const [
      fedFunds, dgs3mo, dgs2, dgs10, breakeven10y, cpi, corePce, realGdp, unemployment,
      claims, m2, m2Growth, hySpread, usd, oil, houst, umcsent, vix, vix3m
    ] = await Promise.all([
      fetchFredSeries("FEDFUNDS", apiKey),
      fetchFredSeries("DGS3MO", apiKey),
      fetchFredSeries("DGS2", apiKey),
      fetchFredSeries("DGS10", apiKey),
      fetchFredSeries("T10YIE", apiKey), // 10Y breakeven inflation (market-implied)
      // CPIAUCSL is an index level; `units=pc1` asks FRED for the year-over-year % change
      // so cpiInflation is a true inflation rate (not a ~310 index value rendered as "%").
      fetchFredSeries("CPIAUCSL", apiKey, "pc1"),
      fetchFredSeries("PCEPILFE", apiKey, "pc1"), // core PCE YoY (Fed's preferred gauge)
      fetchFredSeries("A191RL1Q225SBEA", apiKey), // real GDP, % change SAAR (already a rate)
      fetchFredSeries("UNRATE", apiKey),
      fetchFredSeries("ICSA", apiKey), // initial jobless claims (level)
      fetchFredSeries("M2SL", apiKey),
      // M2 money-supply YoY growth (liquidity) — `pc1` gives the year-over-year % change.
      fetchFredSeries("M2SL", apiKey, "pc1"),
      fetchFredSeries("BAMLH0A0HYM2", apiKey), // ICE BofA US high-yield OAS (%)
      fetchFredSeries("DTWEXBGS", apiKey), // broad trade-weighted USD index
      fetchFredSeries("DCOILWTICO", apiKey), // WTI crude spot ($)
      fetchFredSeries("HOUST", apiKey),
      fetchFredSeries("UMCSENT", apiKey),
      fetchFredSeries("VIXCLS", apiKey),
      fetchFredSeries("VXVCLS", apiKey) // 3-month VIX (term structure)
    ]);

    const data: MacroData = {
      fedFundsRate: fedFunds ? `${Number(fedFunds).toFixed(2)}%` : DEFAULT_MACRO.fedFundsRate,
      dgs3moTreasury: dgs3mo ? `${Number(dgs3mo).toFixed(2)}%` : DEFAULT_MACRO.dgs3moTreasury,
      dgs2Treasury: dgs2 ? `${Number(dgs2).toFixed(2)}%` : DEFAULT_MACRO.dgs2Treasury,
      dgs10Treasury: dgs10 ? `${Number(dgs10).toFixed(2)}%` : DEFAULT_MACRO.dgs10Treasury,
      inflationExpectation10y: breakeven10y ? `${Number(breakeven10y).toFixed(2)}%` : DEFAULT_MACRO.inflationExpectation10y,
      cpiInflation: cpi ? `${Number(cpi).toFixed(2)}%` : DEFAULT_MACRO.cpiInflation,
      corePCE: corePce ? `${Number(corePce).toFixed(2)}%` : DEFAULT_MACRO.corePCE,
      realGDPGrowth: realGdp ? `${Number(realGdp).toFixed(2)}%` : DEFAULT_MACRO.realGDPGrowth,
      unemploymentRate: unemployment ? `${Number(unemployment).toFixed(2)}%` : DEFAULT_MACRO.unemploymentRate,
      initialClaims: claims ? `${Math.round(Number(claims) / 1000)}K` : DEFAULT_MACRO.initialClaims,
      m2MoneySupply: m2 ? `${(Number(m2) / 1000).toFixed(2)}T` : DEFAULT_MACRO.m2MoneySupply,
      m2GrowthYoY: m2Growth ? `${Number(m2Growth).toFixed(2)}%` : DEFAULT_MACRO.m2GrowthYoY,
      hyCreditSpread: hySpread ? `${Number(hySpread).toFixed(2)}%` : DEFAULT_MACRO.hyCreditSpread,
      usdIndex: usd ? `${Number(usd).toFixed(2)}` : DEFAULT_MACRO.usdIndex,
      wtiOil: oil ? `$${Number(oil).toFixed(2)}` : DEFAULT_MACRO.wtiOil,
      housingStarts: houst ? `${(Number(houst) / 1000).toFixed(2)}M` : DEFAULT_MACRO.housingStarts,
      consumerSentiment: umcsent ? `${Number(umcsent).toFixed(1)}` : DEFAULT_MACRO.consumerSentiment,
      vix: vix ? `${Number(vix).toFixed(2)}` : DEFAULT_MACRO.vix,
      vix3m: vix3m ? `${Number(vix3m).toFixed(2)}` : DEFAULT_MACRO.vix3m,
      asOf: new Date().toISOString().split("T")[0]
    };

    cache.data = data;
    cache.expiresAt = now + CACHE_TTL_MS;
    return data;
  } catch (error) {
    console.error("[macro] failed to fetch macroeconomic data:", error);
    return DEFAULT_MACRO;
  }
}

// Regime-critical fields that are always worth the tokens even when unchanged.
const MACRO_ALWAYS_KEEP = new Set<keyof MacroData>(["vix", "fedFundsRate", "dgs10Treasury", "asOf"]);

/**
 * Delta-only macro pruning: macro data moves slowly, so on repeat runs only send
 * the fields that changed since the last run (plus a few regime-critical ones),
 * and list the rest as "unchanged" instead of re-spending tokens on them.
 */
export function pruneMacro(
  current: MacroData,
  previous?: MacroData | null
): { macro: Record<string, string>; omitted: string[] } {
  if (!previous) return { macro: { ...current }, omitted: [] };
  const macro: Record<string, string> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(current) as Array<[keyof MacroData, string]>) {
    if (MACRO_ALWAYS_KEEP.has(key) || previous[key] !== value) {
      macro[key] = value;
    } else {
      omitted.push(key);
    }
  }
  return { macro, omitted };
}

/**
 * Deterministic market-regime classifier. Primary axis is VIX (volatility), but the
 * yield curve (10y vs Fed funds) actually participates now: an inverted curve — a
 * classic recession/risk signal — nudges borderline VIX readings toward risk-off and
 * surfaces a distinct "Cautious (Inverted Curve)" regime in calm-but-inverted markets.
 * Kept to a small, repeatable label set so the thesis×regime learning buckets stay
 * dense enough to learn from. Richer macro detail still reaches the LLM via the prompt.
 */
export function determineMarketRegime(macro: MacroData): string {
  const vix = parseFloat(macro.vix);
  const fedFunds = parseFloat(macro.fedFundsRate);
  const dgs10 = parseFloat(macro.dgs10Treasury);
  // Curve inversion: 10y meaningfully below the policy rate.
  const inverted = Number.isFinite(fedFunds) && Number.isFinite(dgs10) && dgs10 < fedFunds - 0.1;
  if (Number.isFinite(vix)) {
    if (vix > 30) return "Crisis (Extreme Volatility)";
    if (vix > 20 || (inverted && vix > 17)) return "Risk-Off (High Volatility)";
    if (vix < 13 && !inverted) return "Risk-On (Low Volatility)";
  }
  return inverted ? "Cautious (Inverted Curve)" : "Neutral (Normal Volatility)";
}

async function fetchFredSeries(seriesId: string, apiKey: string, units?: string): Promise<string | undefined> {
  const unitsParam = units ? `&units=${units}` : "";
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&limit=1&sort_order=desc${unitsParam}&api_key=${apiKey}&file_type=json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return undefined;
    const payload = await response.json() as any;
    const value = payload?.observations?.[0]?.value;
    return value && value !== "." ? String(value) : undefined;
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}
