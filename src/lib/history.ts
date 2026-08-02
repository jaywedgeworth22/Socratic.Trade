// Free daily OHLC price-history fetch — the single source of bars for the app.
//
// Two consumers share this: the technical connector (`web-sources/technical.ts`, which
// only reads closes) and the symbol-drilldown price chart (`/api/history`, which needs
// full candles). Sources cascade keyed-first then free: Massive → Tradier → Tiingo →
// Marketstack → Yahoo. Keyed providers are reliable from datacenter IPs; the free Yahoo
// endpoint is frequently rate-limited (HTTP 429) or bot-challenged server-side, so a keyed
// provider is strongly recommended. Server-side only; cached briefly. Never fabricates —
// no bars → returns null, callers degrade to "—".
//
// Stooq was the terminal free fallback here until 2026-08: research confirmed its daily-CSV
// endpoint now sits behind an Anubis-style JS proof-of-work wall (bot-blocked, not merely
// rate-limited) — integrating around that would mean circumventing bot protection, so the tier
// was removed rather than kept as permanently-dead code. `parseStooqCsv` stays exported (still
// unit-tested as a pure parser, and re-exported from web-sources/technical.ts for back-compat)
// in case a future non-bot-walled CSV source needs the same shape.

import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";
import { fulfillMarketDataDemand, getConnectedAccountByBroker, getImportedPriceCloses, getImportedSpxCloses, hasDataPoolConsent, recordMarketDataDemand, resolveApiKeyWithSource, type ApiKeySource } from "./db";
import { emitDashboardEvent } from "./events";
import { expiresAtRespectingMarketClose } from "./market-hours";
import { recordProviderCall } from "./usage-monitor-push";
import { massiveApiBase, reserveMassiveRestCall } from "./market-signals/massive";
import { fetchRobinhoodHistoricals } from "./robinhood";
import { appAClosesToBars, congressReadsEnabled, getCongressTradeClient } from "./api-clients/congress";
import { BROWSER_UA, politeFetchJson } from "./web-sources/http";
import { admitProviderRequests } from "./provider-rate-limit";
import { apiKeyFingerprint } from "./data-providers";

const DEFAULT_TTL_MS = 30 * 60_000; // daily bars only move intraday on the last candle
const cache = new Map<string, { expiresAt: number; bars: OHLCBar[] }>();
const KEYED_HISTORY_SERVICES = ["massive", "marketstack", "tiingo"] as const;
type CacheScope = "shared" | "private" | "pool";

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
        /** Split-and-dividend-adjusted closes — prefer these over quote.close for multi-year returns. */
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
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
 * first (reliable, generous limits): Massive (Polygon-compatible) → Tradier → Tiingo →
 * Marketstack, then the free fallback Yahoo. Keyed sources are skipped when no user/env key is
 * available. Returns the first source that yields ≥2 bars, or null (never fabricated). The free
 * Yahoo endpoint is frequently rate-limited or bot-challenged from datacenter IPs, so a keyed
 * provider is strongly recommended for reliable charts + the in-house technical "computed"
 * producer.
 */
export async function fetchDailyOHLC(rawSymbol: string, now: number = Date.now(), userId?: string): Promise<OHLCBar[] | null> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return null;

  const keySources: Record<(typeof KEYED_HISTORY_SERVICES)[number], { key?: string; source: ApiKeySource }> = {
    massive: resolveApiKeyWithSource("massive", userId),
    marketstack: resolveApiKeyWithSource("marketstack", userId),
    tiingo: resolveApiKeyWithSource("tiingo", userId)
  };
  const tradierCredential = resolveTradierHistoryCredential();
  const privateCacheKey = historyCacheKey(symbol, userId, "private");
  const poolCacheKey = historyCacheKey(symbol, userId, "pool");
  const sharedCacheKey = historyCacheKey(symbol, userId, "shared");
  const consented = hasDataPoolConsent(userId ?? "local");
  const privateHit = cache.get(privateCacheKey);
  if (privateHit && privateHit.expiresAt > now) return privateHit.bars;
  // The reciprocal pool is read ONLY by consenting users (they also contribute their keyed pulls
  // to it). Non-consenting users skip it entirely and fall through to the public/free shared tier.
  if (consented) {
    const poolHit = cache.get(poolCacheKey);
    if (poolHit && poolHit.expiresAt > now) return poolHit.bars;
  }
  const sharedHit = cache.get(sharedCacheKey);
  if (sharedHit && sharedHit.expiresAt > now) return sharedHit.bars;

  const startDate = new Date(now - 1825 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  // Keyed providers first (brokerage-grade, generous limits, reliable from datacenter IPs),
  // then the free fallbacks. Keyed sources self-skip when their env key is unset.
  const sources: Array<{ scope: CacheScope; fetch: () => Promise<OHLCBar[] | null> }> = [
    // Local imported-EOD cache tier (congress.trade return-path): App A POSTs gap-fill closes to
    // /api/admin/securities/import; they land in imported_price_eod/imported_spx_eod. Reading the local
    // table first (ahead of the App A HTTP read and our keyed providers) lets an imported series displace
    // a re-fetch entirely. DEFAULT OFF + density-guarded inside fetchImportedHistory so a sparse gap-fill
    // never short-circuits with an incomplete series. Close-only bars.
    { scope: "shared", fetch: async () => fetchImportedHistory(symbol) },
    // congress.trade (App A) cache-aside tier: App A also pulls FMP, so reuse its EOD closes first
    // to spend the shared quota once and save App B's own (keyed) history calls. Returns close-only
    // bars (no OHLC), so an enabled price chart renders a line, not candles, on App A hits. No-op
    // unless CONGRESS_TRADE_READS_ENABLED is on; "shared" scope (App A is a public external source).
    { scope: "shared", fetch: () => fetchAppAHistory(symbol) },
    { scope: cacheScopeForKeySource(keySources.massive.source, userId), fetch: () => fetchMassive(symbol, startDate, keySources.massive.key) },
    // Always "shared" — sourced from the owner's own connected broker account, not a per-user key
    // or consent-gated pool contribution (see resolveTradierHistoryCredential's doc comment).
    { scope: "shared", fetch: () => fetchTradier(symbol, startDate, tradierCredential.key, tradierCredential.baseUrl) },
    // Tiingo's free tier (50/hr, 1,000/day) gives real split+dividend-adjusted EOD history — richer
    // than Marketstack's 100/month free cap, so it's seated ahead of Marketstack. Shares the SAME
    // account-wide "tiingo" quota bucket as TiingoEnrichmentProvider (provider-rate-limit.ts
    // RATE_QUOTAS) via admitProviderRequests, so a scan's enrichment calls and a chart's history call
    // can't together bust the real 50/hour cap.
    { scope: cacheScopeForKeySource(keySources.tiingo.source, userId), fetch: () => fetchTiingo(symbol, startDate, keySources.tiingo.key) },
    { scope: cacheScopeForKeySource(keySources.marketstack.source, userId), fetch: () => fetchMarketstack(symbol, keySources.marketstack.key) },
    // First-party broker history — inert unless ROBINHOOD_ADAPTER=mcp + OAuth token present.
    // SECURITY: the Robinhood token is per-user, so this tier is FETCHED only when an explicit
    // userId is in scope. A shared/background pull (no userId — e.g. the computed-technicals
    // refresh that writes a GLOBAL dataset) must not borrow the operator's ('local') broker token.
    // The resulting BARS are public market data (not the user's private account), so — like any
    // other user-keyed source — they are cached consent-pooled: pool tier when the user opted into
    // the reciprocal data pool, otherwise kept private to that user (never force-shared).
    ...(userId
      ? [{ scope: cacheScopeForKeySource("user", userId), fetch: () => fetchRobinhoodHistoricals(symbol, { interval: "day", span: "5year", userId }) }]
      : []),
    { scope: "shared", fetch: () => fetchYahoo(symbol) }
  ];

  for (const source of sources) {
    const bars = await source.fetch();
    if (bars && bars.length >= 2) {
      const cacheKey = source.scope === "private" ? privateCacheKey : source.scope === "pool" ? poolCacheKey : sharedCacheKey;
      cache.set(cacheKey, { expiresAt: expiresAtRespectingMarketClose(new Date(now), historyTtlMs()), bars });
      if (source.scope === "shared") emitHistoryDemandFilled(symbol, now);
      return bars;
    }
  }
  recordMarketDataDemand({ kind: "history", symbol, userId, now });
  return null;
}

function historyCacheKey(symbol: string, userId: string | undefined, scope: CacheScope): string {
  if (scope === "private") return `user:${userId ?? "local"}:${symbol}`;
  if (scope === "pool") return `pool:${symbol}`;
  return `shared:${symbol}`;
}

function cacheScopeForKeySource(source: ApiKeySource, userId: string | undefined): CacheScope {
  if (source !== "user") return "shared"; // env-key / free providers are public — everyone benefits.
  // A user's OWN provider key: shared globally if the env override is on; otherwise contributed to
  // the reciprocal POOL when the user has consented; otherwise kept private to that user.
  if (shareUserKeyedHistory()) return "shared";
  if (hasDataPoolConsent(userId ?? "local")) return "pool";
  return "private";
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
    recordProviderCall("massive", { service: "market-data", ok: true });
    const rows = json?.results ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.c !== "number" || !Number.isFinite(r.c) || typeof r.t !== "number") continue;
      bars.push({ time: r.t, open: numOrUndef(r.o), high: numOrUndef(r.h), low: numOrUndef(r.l), close: r.c, volume: numOrUndef(r.v), vwap: numOrUndef(r.vw) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("massive", { service: "market-data", ok: false });
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

/**
 * Resolves Tradier's price-history credential from the owner's own CONNECTED broker account
 * (connected_accounts, broker "tradier") rather than a separate stored API key — the owner connects
 * Tradier once (even just as a data source, not necessarily as the active EXECUTION broker — see
 * getConnectedAccountByBroker's doc comment) and that connection's access token becomes the app's
 * Tradier price-history source too. Always resolves the "local" (owner's) connection regardless of
 * the requesting userId — a single connected broker naturally serves the whole app, mirroring the
 * "shared-operator-infra" model every other keyed history provider already uses via an env var, just
 * sourced from a broker connection instead. Sandbox vs production tracks the connection's own
 * `environment`, matching tradier.ts's own derivation for order placement.
 */
function resolveTradierHistoryCredential(): { key?: string; baseUrl: string } {
  const acct = getConnectedAccountByBroker("tradier", "local");
  return {
    key: acct?.apiKey?.trim() || undefined,
    baseUrl: acct?.environment === "live" ? "https://api.tradier.com" : "https://sandbox.tradier.com"
  };
}

/** Tradier daily history — brokerage-grade, generous rate limits. Best primary source. */
async function fetchTradier(symbol: string, startDate: string, key: string | undefined, baseUrl: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  try {
    const url = `${baseUrl}/v1/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${startDate}`;
    const json = await politeFetchJson<TradierHistoryResponse>(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    recordProviderCall("tradier", { service: "market-data", ok: true });
    const day = json?.history?.day;
    const days = Array.isArray(day) ? day : day ? [day] : [];
    const bars: OHLCBar[] = [];
    for (const d of days) {
      if (typeof d.close !== "number" || !Number.isFinite(d.close) || !d.date) continue;
      bars.push({ time: d.date, open: numOrUndef(d.open), high: numOrUndef(d.high), low: numOrUndef(d.low), close: d.close, volume: numOrUndef(d.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("tradier", { service: "market-data", ok: false });
    return null;
  }
}

interface TiingoPriceRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  adjOpen?: number;
  adjHigh?: number;
  adjLow?: number;
  adjClose?: number;
  adjVolume?: number;
}

/**
 * Tiingo EOD history (`/tiingo/daily/{ticker}/prices`) — 30+ years of split/dividend-adjusted daily
 * bars on the free Starter tier (50 req/hour, 1,000/day, 500 unique symbols/month). Admits against the
 * SAME "tiingo" quota bucket TiingoEnrichmentProvider uses (provider-rate-limit.ts RATE_QUOTAS), since
 * both draw on one real account-wide rate limit — a scan's enrichment calls must not let a chart's
 * history call (or vice versa) blow the hourly cap. Prefers adjOpen/High/Low/Close over the raw OHLC
 * (same technique fetchYahoo uses: scale raw O/H/L by adjClose/close so all four stay on one basis).
 */
async function fetchTiingo(symbol: string, startDate: string, key?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  const credKey = await apiKeyFingerprint(key);
  if (admitProviderRequests("tiingo", credKey, 1) < 1) return null; // hourly/daily budget exhausted this pass
  try {
    const url = `https://api.tiingo.com/tiingo/daily/${symbol.toLowerCase()}/prices?startDate=${startDate}&token=${key}`;
    const json = await politeFetchJson<TiingoPriceRow[]>(url, { headers: { Authorization: `Token ${key}`, Accept: "application/json" } });
    recordProviderCall("tiingo", { service: "market-data", ok: true });
    const rows = Array.isArray(json) ? json : [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (!r.date) continue;
      const rawClose = numOrUndef(r.close);
      const adjClose = numOrUndef(r.adjClose);
      const close = adjClose ?? rawClose;
      if (close === undefined) continue;
      let o = numOrUndef(r.open);
      let h = numOrUndef(r.high);
      let l = numOrUndef(r.low);
      if (adjClose !== undefined && rawClose !== undefined && rawClose !== 0) {
        const factor = adjClose / rawClose;
        if (o !== undefined) o = o * factor;
        if (h !== undefined) h = h * factor;
        if (l !== undefined) l = l * factor;
      }
      bars.push({ time: r.date.slice(0, 10), open: o, high: h, low: l, close, volume: numOrUndef(r.adjVolume ?? r.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("tiingo", { service: "market-data", ok: false });
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
    recordProviderCall("marketstack", { service: "market-data", ok: true });
    const rows = json?.data ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.close !== "number" || !Number.isFinite(r.close) || !r.date) continue;
      bars.push({ time: r.date, open: numOrUndef(r.open), high: numOrUndef(r.high), low: numOrUndef(r.low), close: r.close, volume: numOrUndef(r.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("marketstack", { service: "market-data", ok: false });
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
    const rawClose = q?.close ?? [];
    // Prefer split+dividend-adjusted closes (adjclose) for correct multi-year returns.
    // Fall back to raw close if adjclose is absent or length-mismatched.
    const adjCloseArr = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const useAdjusted = adjCloseArr.length === ts.length;
    if (ts.length === 0 || rawClose.length === 0) return null;
    const bars: OHLCBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const rawC = rawClose[i] ?? null;
      // Per-bar fallback: if adjclose entry is null/non-finite use rawC so Yahoo gaps
      // in adjclose don't cause bars with valid rawclose to be silently dropped.
      const adjEntry = useAdjusted ? (adjCloseArr[i] ?? null) : null;
      const usingAdj = typeof adjEntry === "number" && Number.isFinite(adjEntry);
      const c = usingAdj ? adjEntry : rawC;
      if (typeof c !== "number" || !Number.isFinite(c)) continue; // skip null/holiday gaps
      // Scale O/H/L by adjclose/rawclose so all four OHLC values stay on the same basis.
      // Candle consistency: close cannot fall outside [low, high] after ex-dividend adjustments.
      let o = numOrUndef(q?.open?.[i]);
      let h = numOrUndef(q?.high?.[i]);
      let l = numOrUndef(q?.low?.[i]);
      if (usingAdj && typeof rawC === "number" && Number.isFinite(rawC) && rawC !== 0) {
        const factor = c / rawC;
        if (o !== undefined) o = o * factor;
        if (h !== undefined) h = h * factor;
        if (l !== undefined) l = l * factor;
      }
      bars.push({
        time: ts[i] * 1000, // seconds → ms epoch
        open: o, high: h, low: l,
        close: c,
        volume: numOrUndef(q?.volume?.[i])
      });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

/**
 * Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume) into bars. Pure / unit-tested.
 * The cascade no longer CALLS Stooq (see the header comment — its endpoint sits behind a
 * proof-of-work bot wall as of 2026-08). Kept exported in case a future non-bot-walled CSV
 * source needs the same shape.
 */
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

/**
 * congress.trade (App A) cache-aside source: App A's EOD close series for a symbol (or the S&P-500
 * via ^GSPC) as close-only OHLCBars. Returns null unless reads are enabled AND App A has ≥2 closes,
 * so the cascade falls through to App B's own providers on a miss. Self-guarded inside the client.
 */
async function fetchAppAHistory(symbol: string): Promise<OHLCBar[] | null> {
  if (!congressReadsEnabled()) return null;

  let closes: any[] = [];
  try {
    const client = getCongressTradeClient();
    if (symbol === "^GSPC") {
      closes = await client.getSpx();
    } else {
      const resp = await client.getPrices(symbol);
      closes = resp?.closes ?? [];
    }
  } catch (err) {
    // Ignore error, fallback logic kicks in
  }
  const bars = appAClosesToBars(closes);
  return bars.length >= 2 ? bars : null;
}

function importedHistoryTierEnabled(): boolean {
  const v = (process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Minimum imported closes before the local tier may short-circuit the cascade (avoids sparse gap-fills). */
function importedHistoryMinBars(): number {
  const v = Number(process.env.SECURITIES_IMPORT_MIN_BARS ?? 200);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200;
}

/**
 * Local imported-EOD cache tier (congress.trade return-path). Serves App A's gap-fill closes that were
 * POSTed to /api/admin/securities/import (persisted in imported_price_eod / imported_spx_eod). DEFAULT
 * OFF (SECURITIES_IMPORT_HISTORY_TIER_ENABLED) and density-guarded (SECURITIES_IMPORT_MIN_BARS, default
 * 200 ≈ ~10 months) so a sparse gap-fill never displaces a full fetch with an incomplete series.
 * Close-only bars (no OHLC), like the App A HTTP tier — an enabled price chart renders a line on hits.
 */
function fetchImportedHistory(symbol: string): OHLCBar[] | null {
  if (!importedHistoryTierEnabled()) return null;
  const closes = symbol === "^GSPC" ? getImportedSpxCloses() : getImportedPriceCloses(symbol);
  if (closes.length < importedHistoryMinBars()) return null;
  const bars = appAClosesToBars(closes);
  return bars.length >= 2 ? bars : null;
}
