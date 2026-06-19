// Free daily OHLC price-history fetch — the single source of bars for the app.
//
// Two consumers share this: the technical connector (`web-sources/technical.ts`, which
// only reads closes) and the symbol-drilldown price chart (`/api/history`, which needs
// full candles). Sources cascade keyed-first then free: Massive → Tradier → Marketstack →
// Yahoo → Stooq. Keyed providers are reliable from datacenter IPs; the free endpoints
// (Yahoo/Stooq) are frequently rate-limited (HTTP 429) or bot-challenged server-side, so a
// keyed provider is strongly recommended. Server-side only; cached briefly. Never fabricates
// — no bars → returns null, callers degrade to "—".

import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";
import { fulfillMarketDataDemand, recordMarketDataDemand, resolveApiKeyWithSource, type ApiKeySource } from "./db";
import { emitDashboardEvent } from "./events";
import { massiveApiBase, reserveMassiveRestCall } from "./market-signals/massive";
import { fetchRobinhoodHistoricals } from "./robinhood";
import { BROWSER_UA, politeFetchJson, politeFetchText } from "./web-sources/http";

const DEFAULT_TTL_MS = 30 * 60_000; // daily bars only move intraday on the last candle
const cache = new Map<string, { expiresAt: number; bars: OHLCBar[] }>();
const KEYED_HISTORY_SERVICES = ["massive", "tradier", "marketstack"] as const;
type CacheScope = "shared" | "private";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
}

function historyTtlMs(): number {
  const v = Number(process.env.HISTORY_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

/**
 * Fetch ~5y of daily OHLC bars for a symbol, cached briefly. Cascades keyed providers
 * first (reliable, generous limits): Massive (Polygon-compatible) → Tradier → Marketstack,
 * then the free fallbacks Yahoo → Stooq. Keyed sources are skipped when no user/env key is
 * available. Returns the first source that yields ≥2 bars, or null (never fabricated). Free
 * endpoints (Yahoo/Stooq) are frequently rate-limited or bot-challenged from datacenter IPs,
 * so a keyed provider is strongly recommended for reliable charts + the in-house technical
 * "computed" producer.
 */
export async function fetchDailyOHLC(rawSymbol: string, now: number = Date.now(), userId?: string): Promise<OHLCBar[] | null> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return null;

  const keySources: Record<(typeof KEYED_HISTORY_SERVICES)[number], { key?: string; source: ApiKeySource }> = {
    massive: resolveApiKeyWithSource("massive", userId),
    tradier: resolveApiKeyWithSource("tradier", userId),
    marketstack: resolveApiKeyWithSource("marketstack", userId)
  };
  const privateCacheKey = historyCacheKey(symbol, userId, "private");
  const sharedCacheKey = historyCacheKey(symbol, userId, "shared");
  const privateHit = cache.get(privateCacheKey);
  if (privateHit && privateHit.expiresAt > now) return privateHit.bars;
  const sharedHit = cache.get(sharedCacheKey);
  if (sharedHit && sharedHit.expiresAt > now) return sharedHit.bars;

  const startDate = new Date(now - 1825 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  // Keyed providers first (brokerage-grade, generous limits, reliable from datacenter IPs),
  // then the free fallbacks. Keyed sources self-skip when their env key is unset.
  const sources: Array<{ scope: CacheScope; fetch: () => Promise<OHLCBar[] | null> }> = [
    { scope: cacheScopeForKeySource(keySources.massive.source), fetch: () => fetchMassive(symbol, startDate, keySources.massive.key) },
    { scope: cacheScopeForKeySource(keySources.tradier.source), fetch: () => fetchTradier(symbol, startDate, keySources.tradier.key) },
    { scope: cacheScopeForKeySource(keySources.marketstack.source), fetch: () => fetchMarketstack(symbol, keySources.marketstack.key) },
    // First-party broker history — inert unless ROBINHOOD_ADAPTER=mcp + OAuth token present.
    { scope: "private", fetch: () => fetchRobinhoodHistoricals(symbol, { interval: "day", span: "5year" }) },
    { scope: "shared", fetch: () => fetchYahoo(symbol) },
    { scope: "shared", fetch: () => fetchStooq(symbol) }
  ];

  for (const source of sources) {
    const bars = await source.fetch();
    if (bars && bars.length >= 2) {
      cache.set(source.scope === "private" ? privateCacheKey : sharedCacheKey, { expiresAt: now + historyTtlMs(), bars });
      if (source.scope === "shared") emitHistoryDemandFilled(symbol, now);
      return bars;
    }
  }
  recordMarketDataDemand({ kind: "history", symbol, userId, now });
  return null;
}

function historyCacheKey(symbol: string, userId: string | undefined, scope: CacheScope): string {
  if (scope === "private") return `user:${userId ?? "local"}:${symbol}`;
  return `shared:${symbol}`;
}

function cacheScopeForKeySource(source: ApiKeySource): CacheScope {
  if (source === "user" && !shareUserKeyedHistory()) return "private";
  return "shared";
}

function shareUserKeyedHistory(): boolean {
  const value = (process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY ?? "off").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function emitHistoryDemandFilled(symbol: string, now: number): void {
  const fill = fulfillMarketDataDemand({ kind: "history", symbol, now });
  if (!fill) return;
  emitDashboardEvent({
    type: "market-data",
    at: new Date(now).toISOString(),
    detail: {
      kind: fill.kind,
      cacheScope: "shared",
      pendingUserCount: fill.pendingUserCount,
      oldestRequestedAt: fill.oldestRequestedAt,
      latestRequestedAt: fill.latestRequestedAt
    }
  });
}

interface MassiveAggBar { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number }
interface MassiveAggResponse { results?: MassiveAggBar[] }

/** Massive daily aggregates (Polygon-compatible REST). Generous limits — the preferred primary. */
async function fetchMassive(symbol: string, startDate: string, key?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  if ((process.env.MASSIVE_HISTORY_ENABLED ?? "on").toLowerCase() === "off") return null;
  if (!reserveMassiveRestCall()) return null;
  const base = massiveApiBase();
  const to = new Date().toISOString().slice(0, 10);
  try {
    const url = `${base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${startDate}/${to}?adjusted=true&sort=asc&limit=50000`;
    const json = await politeFetchJson<MassiveAggResponse>(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    const rows = json?.results ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.c !== "number" || !Number.isFinite(r.c) || typeof r.t !== "number") continue;
      bars.push({ time: r.t, open: numOrUndef(r.o), high: numOrUndef(r.h), low: numOrUndef(r.l), close: r.c, volume: numOrUndef(r.v), vwap: numOrUndef(r.vw) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

interface TradierHistoryDay {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
interface TradierHistoryResponse {
  history?: { day?: TradierHistoryDay | TradierHistoryDay[] } | null;
}

/** Tradier daily history — brokerage-grade, generous rate limits. Best primary source. */
async function fetchTradier(symbol: string, startDate: string, key?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  const base = process.env.TRADIER_BASE_URL ?? "https://api.tradier.com";
  try {
    const url = `${base}/v1/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${startDate}`;
    const json = await politeFetchJson<TradierHistoryResponse>(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    const day = json?.history?.day;
    const days = Array.isArray(day) ? day : day ? [day] : [];
    const bars: OHLCBar[] = [];
    for (const d of days) {
      if (typeof d.close !== "number" || !Number.isFinite(d.close) || !d.date) continue;
      bars.push({ time: d.date, open: numOrUndef(d.open), high: numOrUndef(d.high), low: numOrUndef(d.low), close: d.close, volume: numOrUndef(d.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

interface MarketstackEodRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
interface MarketstackEodResponse {
  data?: MarketstackEodRow[];
}

/** Marketstack EOD — keyed fallback (free tier is monthly-capped, so secondary to Tradier). */
async function fetchMarketstack(symbol: string, key?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  try {
    const url = `https://api.marketstack.com/v1/eod?access_key=${key}&symbols=${encodeURIComponent(symbol)}&limit=1500&sort=ASC`;
    const json = await politeFetchJson<MarketstackEodResponse>(url, {});
    const rows = json?.data ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.close !== "number" || !Number.isFinite(r.close) || !r.date) continue;
      bars.push({ time: r.date, open: numOrUndef(r.open), high: numOrUndef(r.high), low: numOrUndef(r.low), close: r.close, volume: numOrUndef(r.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

async function fetchYahoo(symbol: string): Promise<OHLCBar[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
    const json = await politeFetchJson<YahooChartResponse>(url, { headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    const close = q?.close ?? [];
    if (ts.length === 0 || close.length === 0) return null;
    const bars: OHLCBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = close[i];
      if (typeof c !== "number" || !Number.isFinite(c)) continue; // skip null/holiday gaps
      bars.push({
        time: ts[i] * 1000, // seconds → ms epoch
        open: numOrUndef(q?.open?.[i]),
        high: numOrUndef(q?.high?.[i]),
        low: numOrUndef(q?.low?.[i]),
        close: c,
        volume: numOrUndef(q?.volume?.[i])
      });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

async function fetchStooq(symbol: string): Promise<OHLCBar[] | null> {
  try {
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&i=d`;
    const text = await politeFetchText(url, { headers: { "user-agent": BROWSER_UA } });
    const bars = parseStooqCsv(text);
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

/** Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume) into bars. Pure / unit-tested. */
export function parseStooqCsv(text: string): OHLCBar[] {
  const out: OHLCBar[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const [date, open, high, low, close, volume] = parts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skips the header row
    const c = Number(close);
    if (!Number.isFinite(c)) continue;
    out.push({
      time: date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: c,
      volume: volume ? Number(volume) : undefined
    });
  }
  return out;
}

/** Normalize a bar's `time` (ms-epoch number or date string) to a 'YYYY-MM-DD' business day. */
export function toBusinessDay(time: number | string | undefined): string | undefined {
  if (typeof time === "number" && Number.isFinite(time)) {
    const ms = time > 1e12 ? time : time * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof time === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(time)) return time.slice(0, 10);
    const parsed = Date.parse(time);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return undefined;
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clearHistoryCache(): void {
  cache.clear();
}
