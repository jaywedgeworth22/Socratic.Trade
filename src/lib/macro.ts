export interface MacroData {
  fedFundsRate: string;
  dgs10Treasury: string;
  cpiInflation: string;
  unemploymentRate: string;
  m2MoneySupply: string;
  housingStarts: string;
  consumerSentiment: string;
  vix: string;
  asOf: string;
}

const DEFAULT_MACRO: MacroData = {
  fedFundsRate: "5.25%",
  dgs10Treasury: "4.20%",
  cpiInflation: "3.10%",
  unemploymentRate: "3.90%",
  m2MoneySupply: "20.8T",
  housingStarts: "1.3M",
  consumerSentiment: "75.0",
  vix: "15.00",
  asOf: new Date().toISOString().split("T")[0]
};

const cache: { expiresAt: number; data: MacroData | null } = {
  expiresAt: 0,
  data: null
};

const CACHE_TTL_MS = 24 * 60 * 60_000; // Macro data moves slowly; cache 24h

export async function fetchMacroData(): Promise<MacroData> {
  const now = Date.now();
  if (cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return DEFAULT_MACRO;
  }

  try {
    const [fedFunds, dgs10, cpi, unemployment, m2, houst, umcsent, vix] = await Promise.all([
      fetchFredSeries("FEDFUNDS", apiKey),
      fetchFredSeries("DGS10", apiKey),
      fetchFredSeries("CPIAUCSL", apiKey),
      fetchFredSeries("UNRATE", apiKey),
      fetchFredSeries("M2SL", apiKey),
      fetchFredSeries("HOUST", apiKey),
      fetchFredSeries("UMCSENT", apiKey),
      fetchFredSeries("VIXCLS", apiKey)
    ]);

    const data: MacroData = {
      fedFundsRate: fedFunds ? `${Number(fedFunds).toFixed(2)}%` : DEFAULT_MACRO.fedFundsRate,
      dgs10Treasury: dgs10 ? `${Number(dgs10).toFixed(2)}%` : DEFAULT_MACRO.dgs10Treasury,
      cpiInflation: cpi ? `${Number(cpi).toFixed(2)}%` : DEFAULT_MACRO.cpiInflation,
      unemploymentRate: unemployment ? `${Number(unemployment).toFixed(2)}%` : DEFAULT_MACRO.unemploymentRate,
      m2MoneySupply: m2 ? `${(Number(m2) / 1000).toFixed(2)}T` : DEFAULT_MACRO.m2MoneySupply,
      housingStarts: houst ? `${(Number(houst) / 1000).toFixed(2)}M` : DEFAULT_MACRO.housingStarts,
      consumerSentiment: umcsent ? `${Number(umcsent).toFixed(1)}` : DEFAULT_MACRO.consumerSentiment,
      vix: vix ? `${Number(vix).toFixed(2)}` : DEFAULT_MACRO.vix,
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

async function fetchFredSeries(seriesId: string, apiKey: string): Promise<string | undefined> {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&limit=1&sort_order=desc&api_key=${apiKey}&file_type=json`;
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
