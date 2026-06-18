/**
 * Massive market data (api.massive.com) — a Polygon-compatible REST API (Bearer auth with
 * MASSIVE_API_KEY). We use the grouped-daily endpoint, which returns every US stock's OHLCV
 * for a single day in one call (~12k tickers), to compute TRUE full-universe market breadth —
 * a much broader read than the ~30-candidate sample in `marketInternals`. Two consecutive
 * trading days give each name's real day-over-day change. Failure-tolerant; never fabricated.
 *
 * (Massive also exposes S3 "flat files" at files.massive.com with the same key as the SECRET —
 * note MASSIVE_SECRET_ACCESS_KEY in .env had a one-char typo; the API key is the real secret.
 * We use the REST API here, so no S3 signing is needed.)
 */

export interface FullMarketBreadth {
  /** % of the full US universe advancing day-over-day. */
  breadthPct?: number;
  advancers: number;
  decliners: number;
  /** Most liquid biggest movers (volume-filtered to avoid penny-stock noise). */
  topGainers: Array<{ sym: string; pct: number }>;
  topLosers: Array<{ sym: string; pct: number }>;
  asOf?: string;
  universe: number;
}

interface GroupedBar { T?: string; c?: number; v?: number }
interface GroupedResponse { status?: string; results?: GroupedBar[] }

function apiBase(): string {
  return process.env.MASSIVE_API_BASE ?? "https://api.massive.com";
}

/** Last `n` calendar days as YYYY-MM-DD, newest first (weekends/holidays return empty + are skipped). */
function recentDates(n: number, now: number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(new Date(now - i * 24 * 60 * 60_000).toISOString().slice(0, 10));
  }
  return out;
}

async function fetchGrouped(date: string, key: string): Promise<Map<string, { close: number; vol: number }> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const url = `${apiBase()}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`;
    const res = await fetch(url, { cache: "no-store", signal: controller.signal, headers: { Authorization: `Bearer ${key}` } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as GroupedResponse;
    const rows = json?.results ?? [];
    if (rows.length === 0) return null;
    const map = new Map<string, { close: number; vol: number }>();
    for (const r of rows) {
      if (typeof r.T === "string" && typeof r.c === "number" && Number.isFinite(r.c) && r.c > 0) {
        map.set(r.T, { close: r.c, vol: typeof r.v === "number" ? r.v : 0 });
      }
    }
    return map.size > 0 ? map : null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

const MIN_VOLUME_FOR_MOVERS = 1_000_000; // ignore illiquid names when ranking movers

export async function fetchFullMarketBreadth(now: number = Date.now()): Promise<FullMarketBreadth | undefined> {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) return undefined;

  // Collect the two most recent trading days that have data.
  const days: Array<{ date: string; map: Map<string, { close: number; vol: number }> }> = [];
  for (const date of recentDates(6, now)) {
    const map = await fetchGrouped(date, key);
    if (map && map.size > 100) days.push({ date, map });
    if (days.length === 2) break;
  }
  if (days.length < 2) return undefined;

  const [today, prev] = days; // newest first
  let advancers = 0;
  let decliners = 0;
  const movers: Array<{ sym: string; pct: number }> = [];
  for (const [sym, t] of today.map) {
    const p = prev.map.get(sym);
    if (!p || p.close <= 0) continue;
    const pct = ((t.close - p.close) / p.close) * 100;
    if (pct > 0) advancers += 1;
    else if (pct < 0) decliners += 1;
    if (t.vol >= MIN_VOLUME_FOR_MOVERS && Number.isFinite(pct)) movers.push({ sym, pct: Math.round(pct * 100) / 100 });
  }
  const total = advancers + decliners;
  movers.sort((a, b) => b.pct - a.pct);
  return {
    breadthPct: total > 0 ? Math.round((advancers / total) * 100) : undefined,
    advancers,
    decliners,
    topGainers: movers.slice(0, 5),
    topLosers: movers.slice(-5).reverse(),
    asOf: today.date,
    universe: total
  };
}
