// Free daily OHLC price-history fetch — the single source of bars for the app.
//
// Two consumers share this: the technical connector (`web-sources/technical.ts`, which
// only reads closes) and the symbol-drilldown price chart (`/api/history`, which needs
// full candles). Sources cascade keyed-first then free: Tradier → Marketstack → Yahoo →
// Stooq. Keyed providers are reliable from datacenter IPs; the free endpoints (Yahoo/Stooq)
// are frequently rate-limited (HTTP 429) or bot-challenged server-side, so a keyed provider
// is strongly recommended. Server-side only; cached briefly. Never fabricates — no bars →
// returns null, callers degrade to "—".

import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";
import { resolveApiKey } from "./db";
import { BROWSER_UA, politeFetchJson, politeFetchText } from "./web-sources/http";

const DEFAULT_TTL_MS = 30 * 60_000; // daily bars only move intraday on the last candle
const cache = new Map<string, { expiresAt: number; bars: OHLCBar[] }>();

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
 * Fetch ~1y of daily OHLC bars for a symbol, cached briefly. Cascades keyed providers
 * first (reliable, generous limits): Massive (Polygon-compatible) → Tradier → Marketstack,
 * then the free fallbacks Yahoo → Stooq. Keyed sources are skipped when their env key is unset. Returns the first source
 * that yields ≥2 bars, or null (never fabricated). Free endpoints (Yahoo/Stooq) are
 * frequently rate-limited or bot-challenged from datacenter IPs, so a keyed provider is
 * strongly recommended for reliable charts + the in-house technical "computed" producer.
 */
export async function fetchDailyOHLC(rawSymbol: string, now: number = Date.now(), userId?: string): Promise<OHLCBar[] | null> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return null;
  const hit = cache.get(symbol);
  if (hit && hit.expiresAt > now) return hit.bars;

  const startDate = new Date(now - 400 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  // Keyed providers first (brokerage-grade, generous limits, reliable from datacenter IPs),
  // then the free fallbacks. Keyed sources self-skip when their env key is unset.
  const sources: Array<() => Promise<OHLCBar[] | null>> = [
    () => fetchMassive(symbol, startDate, userId),
    () => fetchTradier(symbol, startDate, userId),
    () => fetchMarketstack(symbol, userId),
    () => fetchYahoo(symbol),
    () => fetchStooq(symbol)
  ];

  for (const fetchFrom of sources) {
    const bars = await fetchFrom();
    if (bars && bars.length >= 2) {
      cache.set(symbol, { expiresAt: now + historyTtlMs(), bars });
      return bars;
    }
  }
  return null;
}

interface MassiveAggBar { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number }
interface MassiveAggResponse { results?: MassiveAggBar[] }

/** Massive daily aggregates (Polygon-compatible REST). Generous limits — the preferred primary. */
async function fetchMassive(symbol: string, startDate: string, userId?: string): Promise<OHLCBar[] | null> {
  const key = resolveApiKey("massive", userId);
  if (!key) return null;
  const base = process.env.MASSIVE_API_BASE ?? "https://api.massive.com";
  const to = new Date().toISOString().slice(0, 10);
  try {
    const url = `${base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${startDate}/${to}?adjusted=true&sort=asc&limit=50000`;
    const json = await politeFetchJson<MassiveAggResponse>(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    const rows = json?.results ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.c !== "number" || !Number.isFinite(r.c) || typeof r.t !== "number") continue;
      bars.push({ time: r.t, open: numOrUndef(r.o), high: numOrUndef(r.h), low: numOrUndef(r.l), close: r.c, volume: numOrUndef(r.v) });
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
async function fetchTradier(symbol: string, startDate: string, userId?: string): Promise<OHLCBar[] | null> {
  const key = resolveApiKey("tradier", userId);
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
async function fetchMarketstack(symbol: string, userId?: string): Promise<OHLCBar[] | null> {
  const key = resolveApiKey("marketstack", userId);
  if (!key) return null;
  try {
    const url = `https://api.marketstack.com/v1/eod?access_key=${key}&symbols=${encodeURIComponent(symbol)}&limit=300&sort=ASC`;
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
