/**
 * Short trailing histories for the most trend-relevant macro series, fetched from FRED, so the
 * Macro tab can draw sparklines (the main macro layer only keeps the latest value per series).
 * Daily series only (smooth sparklines); cached 12h. Free FRED key required — without it this
 * returns {} and the UI simply omits the trends. Never fabricated.
 */

const FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations";
const POINTS = 90; // ~4–5 months of daily observations

/** Friendly key → FRED series id, for the curated set we sparkline. */
const SERIES: Record<string, string> = {
  tenY: "DGS10",
  twoY: "DGS2",
  vix: "VIXCLS",
  hyCreditSpread: "BAMLH0A0HYM2",
  usd: "DTWEXBGS",
  wti: "DCOILWTICO"
};

export type MacroHistory = Partial<Record<keyof typeof SERIES | string, number[]>>;

const CACHE_TTL_MS = 12 * 60 * 60_000;
const cache: { expiresAt: number; data: MacroHistory | null } = { expiresAt: 0, data: null };

async function fetchSeriesHistory(seriesId: string, apiKey: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${FRED_OBS_URL}?series_id=${seriesId}&limit=${POINTS}&sort_order=desc&api_key=${apiKey}&file_type=json`;
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as { observations?: Array<{ value?: string }> };
    const obs = json?.observations ?? [];
    // API returns newest-first; reverse to chronological and drop missing ('.') values.
    const values: number[] = [];
    for (let i = obs.length - 1; i >= 0; i--) {
      const v = obs[i]?.value;
      if (typeof v === "string" && v !== ".") {
        const n = Number(v);
        if (Number.isFinite(n)) values.push(n);
      }
    }
    return values.length >= 5 ? values : null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export async function fetchMacroHistory(now: number = Date.now()): Promise<MacroHistory> {
  if (cache.data && cache.expiresAt > now) return cache.data;
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return {};

  const entries = Object.entries(SERIES);
  const results = await Promise.all(entries.map(([, id]) => fetchSeriesHistory(id, apiKey).catch(() => null)));
  const data: MacroHistory = {};
  entries.forEach(([key], i) => {
    const series = results[i];
    if (series && series.length > 0) data[key] = series;
  });

  cache.data = data;
  cache.expiresAt = now + CACHE_TTL_MS;
  return data;
}
