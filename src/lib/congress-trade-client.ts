// Read client for congress.trade (App A) — server-only, cache-aside + congress source.
//
// App A also pulls FMP (its own key + cron + backfill) and exposes public, read-only endpoints
// that mirror the import payload shapes, plus a congressional-trade feed. App B reads App A FIRST
// and only falls back to its own providers/FMP on a miss — so whoever fetches a given symbol first
// pays for it once. This is the reverse of `congress-share.ts` (which PUSHES to App A's import
// endpoint).
//
// Two independent gates (both default OFF, so all of this is inert until enabled):
//   • CONGRESS_TRADE_READS_ENABLED        → market reads (bundle/ref/refs/prices/spx) cache-aside
//   • CONGRESS_TRADE_AS_CONGRESS_SOURCE   → the /api/transactions congressional feed
// Fully self-guarded — a slow/erroring App A never breaks an App B fetch; it just falls through.
//
// Endpoints (from App A's app/docs/fmp-data-sharing.md):
//   GET /api/market/bundle/{T}?from=&to=  -> { ref, prices:{ticker,closes,currentPrice,...}, spx }
//   GET /api/market/ref/{T}               -> { ref }
//   GET /api/market/refs?tickers=A,B,C    -> { refs:[...] }   (<=500)
//   GET /api/market/prices/{T}?from=&to=  -> { ticker, closes, currentPrice, currentPriceDate }
//   GET /api/market/spx?from=&to=         -> { closes }
//   GET /api/transactions?since=&ticker=&member=&chamber=&type=&limit=

import type { CongressClose, CongressPrice, CongressRef } from "./congress-share";
import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";

const DEFAULT_BASE_URL = "https://congress.trade";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REFS_PER_REQUEST = 500;

export interface AppABundle {
  ref: CongressRef | null;
  prices: CongressPrice | null;
  spx: CongressClose[];
}

export interface AppATransactionsPage {
  transactions: unknown[]; // raw App A rows — normalized by the congress integration (App A shape TBD)
  cursor?: string;
  count?: number;
  total?: number;
  limit?: number;
  premium?: boolean;
  gated?: boolean;
  freeWindowDays?: number;
}

export interface AppATransactionsQuery {
  since?: string;
  ticker?: string;
  member?: string;
  chamber?: string;
  type?: string;
  limit?: number;
}

function baseUrl(): string {
  return (process.env.CONGRESS_TRADE_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function flagOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Whether App B should read App A's MARKET cache (refs/prices/spx) before its own providers. */
export function congressReadsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_READS_ENABLED);
}

/** Whether App B should source congressional trades from App A's /api/transactions feed. */
export function congressAsCongressSourceEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE);
}

/** Optional bearer for App A's public MARKET reads (reads are public; token only if App A gates them). */
function readToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_READ_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

/** Bearer for App A's token-gated /api/transactions full feed — the shared INGEST_TOKEN. */
function ingestToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function timeoutMs(): number {
  const v = Number(process.env.CONGRESS_TRADE_READ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/** GET a path on App A and return parsed JSON, or null on error/non-2xx. Never throws. (Ungated.) */
async function getJson<T>(path: string, token?: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      signal: controller.signal,
      cache: "no-store"
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // fall through to App B's own providers
  } finally {
    clearTimeout(timer);
  }
}

function dateRangeQuery(opts?: { from?: string; to?: string }): string {
  const params = new URLSearchParams();
  if (opts?.from) params.set("from", opts.from);
  if (opts?.to) params.set("to", opts.to);
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** One round-trip: ref + closes + spx for a ticker. Null when reads are off / on any error. */
export async function getAppABundle(ticker: string, opts?: { from?: string; to?: string }): Promise<AppABundle | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  const json = await getJson<{ ref?: CongressRef | null; prices?: CongressPrice | null; spx?: CongressClose[] }>(
    `/api/market/bundle/${encodeURIComponent(sym)}${dateRangeQuery(opts)}`,
    readToken()
  );
  if (!json) return null;
  return { ref: json.ref ?? null, prices: json.prices ?? null, spx: Array.isArray(json.spx) ? json.spx : [] };
}

export async function getAppARef(ticker: string): Promise<CongressRef | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  const json = await getJson<{ ref?: CongressRef | null }>(`/api/market/ref/${encodeURIComponent(sym)}`, readToken());
  return json?.ref ?? null;
}

export async function getAppARefs(tickers: string[]): Promise<CongressRef[]> {
  if (!congressReadsEnabled()) return [];
  const syms = Array.from(new Set(tickers.map(normalizeSymbol).filter(Boolean))).slice(0, MAX_REFS_PER_REQUEST);
  if (syms.length === 0) return [];
  const json = await getJson<{ refs?: CongressRef[] }>(`/api/market/refs?tickers=${encodeURIComponent(syms.join(","))}`, readToken());
  return Array.isArray(json?.refs) ? json!.refs : [];
}

export async function getAppAPrices(ticker: string, opts?: { from?: string; to?: string }): Promise<CongressPrice | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  const json = await getJson<CongressPrice>(`/api/market/prices/${encodeURIComponent(sym)}${dateRangeQuery(opts)}`, readToken());
  return json && Array.isArray(json.closes) ? json : null;
}

export async function getAppASpx(opts?: { from?: string; to?: string }): Promise<CongressClose[]> {
  if (!congressReadsEnabled()) return [];
  const json = await getJson<{ closes?: CongressClose[] }>(`/api/market/spx${dateRangeQuery(opts)}`, readToken());
  return Array.isArray(json?.closes) ? json!.closes : [];
}

/** Pull a page of congressional transactions. Null when the congress-source gate is off / on error. */
export async function getAppATransactions(query: AppATransactionsQuery = {}): Promise<AppATransactionsPage | null> {
  if (!congressAsCongressSourceEnabled()) return null;
  const params = new URLSearchParams();
  if (query.since) params.set("since", query.since);
  if (query.ticker) params.set("ticker", query.ticker);
  if (query.member) params.set("member", query.member);
  if (query.chamber) params.set("chamber", query.chamber);
  if (query.type) params.set("type", query.type);
  if (query.limit) params.set("limit", String(query.limit));
  const qs = params.toString();
  // Token-gated full feed: send the shared INGEST_TOKEN so App A returns ungated, gap-free rows
  // (the public/unauthenticated feed is capped to a 30-day / 50-row window — too small for the
  // 60–90d congressional signal window).
  const json = await getJson<AppATransactionsPage>(`/api/transactions${qs ? `?${qs}` : ""}`, ingestToken());
  if (!json || !Array.isArray(json.transactions)) return null;
  return json;
}

/**
 * Convert App A's {date, close} series to OHLCBars (close-only — open/high/low/volume undefined,
 * which OHLCBar permits). Suitable for close-series consumers (technical/returns); a price chart
 * fed from these renders a line, not candles. Ascending by date.
 */
export function appAClosesToBars(closes: CongressClose[] | null | undefined): OHLCBar[] {
  if (!closes || closes.length === 0) return [];
  return closes
    .filter((c) => c && typeof c.close === "number" && Number.isFinite(c.close) && typeof c.date === "string")
    .map((c) => ({ time: c.date, close: c.close }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
