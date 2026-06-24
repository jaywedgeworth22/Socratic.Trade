// Outbound data-share to congress.trade (App A) — server-only.
//
// App A (congress.trade, a Cloudflare Worker backed by a DB) is the shared system-of-record
// for company reference + daily-close data. Both apps consume Financial Modeling Prep (FMP),
// which has a shared daily quota. To keep App A from spending that quota, this app forwards the
// company-reference + daily-close + S&P-500 data it ALREADY has to App A's idempotent import
// endpoint. App A upserts securities_ref / spx_eod / price_eod and recomputes per-trade anchors.
//
// NOTE on sourcing: this app does NOT fetch FMP /v3/profile or /v3/historical-price-full — its
// only FMP use is the fundamentals enrichment cascade (ratios/grades/insider/senate). The refs +
// closes we forward come from the app's existing sources (NASDAQ screener enrichment for refs;
// the history cascade Massive → Tradier → Marketstack → Yahoo → Stooq for closes). App A just
// needs the DATA, not FMP-sourced data, so sharing it still conserves App A's FMP quota.
//
// Safety: default OFF. Automatic forwarding (scan-refs + the nightly batch) runs only when
// CONGRESS_TRADE_TOKEN is set AND CONGRESS_SHARE_ENABLED is on. The admin route can trigger a
// manual run with just the token. The token is a server-only secret — never exposed to the browser.

import { audit, getInternalSetting, getPolicy, listUsers, listWatchlistSymbols, setInternalSetting } from "./db";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import { symbolsForPolicyUniverse } from "./index-universes";
import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";
import type { MarketQuote, MarketScan } from "./types";
import { getFinraDataset, getInsiderDataset, getInsiderSignals, getShortVolumeSignals } from "./web-sources";

const IMPORT_PATH = "/api/admin/securities/import";
const DEFAULT_BASE_URL = "https://congress.trade";
const DEFAULT_TIMEOUT_MS = 15_000;
const LAST_DAILY_RUN_KEY = "congress-share:lastDailyRunDate";

// Endpoint caps (from the import contract): ≤ ~2,000 tickers / ≤ ~20,000 closes per call.
const MAX_REFS_PER_POST = 2000;
const MAX_TICKERS_PER_POST = 2000;
const CLOSE_BUDGET_PER_POST = 18_000; // stay safely under the 20k closes/call ceiling

// ── Configuration / gating ────────────────────────────────────────────────────

/** The App A bearer token (ADMIN_TOKEN or INGEST_TOKEN). Server-only; trimmed; empty → undefined. */
export function congressTradeToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function congressTradeBaseUrl(): string {
  const base = (process.env.CONGRESS_TRADE_BASE_URL ?? DEFAULT_BASE_URL).trim();
  return base.replace(/\/+$/, "");
}

function flagOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Whether AUTOMATIC forwarding (the scan-refs hook + the nightly batch) is enabled. Requires both
 * the token AND an explicit CONGRESS_SHARE_ENABLED opt-in, so a configured token alone never starts
 * silently pushing data off-box. The admin route bypasses the flag (token-only) for manual ops.
 */
export function isCongressShareAutoEnabled(): boolean {
  return congressTradeToken() !== undefined && flagOn(process.env.CONGRESS_SHARE_ENABLED);
}

function maxDailyTickers(): number {
  const v = Number(process.env.CONGRESS_SHARE_MAX_TICKERS ?? 2000);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), MAX_TICKERS_PER_POST) : 2000;
}

function refTtlMs(): number {
  const v = Number(process.env.CONGRESS_SHARE_REF_TTL_MS ?? 6 * 60 * 60_000);
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60_000;
}

// ── Payload types (mirror App A's import contract; we send subsets we have) ─────

export type CongressAssetClass = "equity" | "etf" | "adr" | "fund" | "other";

export interface CongressRef {
  ticker: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  assetClass?: CongressAssetClass;
  isEtf?: boolean;
  isAdr?: boolean;
  country?: string;
  stateHq?: string;
  stateOfIncorp?: string;
  exchange?: string;
  exchangeShort?: string;
  currency?: string;
  marketCap?: number;
  ipoDate?: string;
  cik?: string;
  sicCode?: string;
  sicDescription?: string;
}

export interface CongressClose {
  date: string; // YYYY-MM-DD
  close: number;
  volume?: number; // App A's price path now carries volume; open/high/low stay App B-only
}

export interface CongressPrice {
  ticker: string;
  closes: CongressClose[];
  currentPrice?: number;
  currentPriceDate?: string;
}

/** SEC Form-4 insider row in App A's import shape (highest-fit dataset App B shares). */
export interface CongressInsider {
  ticker: string;
  date: string; // YYYY-MM-DD (most recent filing)
  sentiment: number; // 0–100 net-buy skew
  buyFilings: number;
  sellFilings: number;
  buyShares: number;
  sellShares: number;
  owners: string[];
}

/** FINRA daily short-volume row in App A's import shape. */
export interface CongressShortVol {
  ticker: string;
  date: string; // YYYY-MM-DD (as-of)
  ratio: number; // % of the day's volume that was short
  elevated: boolean;
}

/** Fundamentals row in App A's import shape (PR #46). Keyed by ticker+date; missing → null on A. */
export interface CongressFundamental {
  ticker: string;
  date: string; // YYYY-MM-DD (as-of)
  peRatio?: number;
  eps?: number;
  beta?: number;
  dividendYield?: number;
  week52High?: number;
  week52Low?: number;
  fcfYield?: number;
  debtToEquity?: number;
  epsGrowth?: number;
}

/** Analyst-consensus row in App A's import shape (PR #46). App B has no price targets → omitted. */
export interface CongressAnalyst {
  ticker: string;
  date: string; // YYYY-MM-DD (as-of)
  rating?: string; // blended consensus label
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
}

export interface CongressSharePayload {
  refs?: CongressRef[];
  spx?: CongressClose[];
  prices?: CongressPrice[];
  insider?: CongressInsider[];
  shortVolume?: CongressShortVol[];
  fundamentals?: CongressFundamental[];
  analyst?: CongressAnalyst[];
}

export interface CongressShareResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
  response?: unknown;
  error?: string;
  /** Counts actually transmitted across all POSTs in this call. */
  sent: {
    refs: number;
    spx: number;
    prices: number;
    closes: number;
    insider: number;
    shortVolume: number;
    fundamentals: number;
    analyst: number;
  };
}

// ── Mappers (pure, unit-testable) ──────────────────────────────────────────────

/**
 * Map an app MarketQuote/summary to a (partial) company ref. This app only knows
 * name/sector/industry/market-cap — never CIK, exchange, country, ipoDate, etc. — and every name
 * in the screener universe is an equity, so assetClass defaults to "equity". Undefined fields are
 * omitted (the endpoint accepts any subset). Returns null when there is no usable ticker.
 */
export function marketQuoteToRef(
  q: Pick<MarketQuote, "symbol" | "companyName" | "sector" | "industry" | "marketCap">
): CongressRef | null {
  const ticker = normalizeSymbol(q.symbol);
  if (!ticker) return null;
  const ref: CongressRef = { ticker, assetClass: "equity" };
  if (q.companyName) ref.companyName = q.companyName;
  if (q.sector) ref.sector = q.sector;
  if (q.industry) ref.industry = q.industry;
  if (typeof q.marketCap === "number" && Number.isFinite(q.marketCap) && q.marketCap > 0) {
    ref.marketCap = q.marketCap;
  }
  return ref;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Map a scanned MarketQuote's fundamentals to App A's import row (PR #46). `date` is the as-of day.
 * Returns null when the quote carries no fundamental values (nothing worth sending). App A saves App B's
 * FMP quota by accepting these — App B already fetched them during the scan.
 */
export function marketQuoteToFundamentals(
  q: Pick<MarketQuote, "symbol" | "peRatio" | "eps" | "beta" | "dividendYield" | "fiftyTwoWeekHigh" | "fiftyTwoWeekLow" | "fcfYield" | "debtToEquity" | "epsGrowth">,
  date: string
): CongressFundamental | null {
  const ticker = normalizeSymbol(q.symbol);
  if (!ticker) return null;
  const row: CongressFundamental = { ticker, date };
  const pe = numOrUndef(q.peRatio); if (pe !== undefined) row.peRatio = pe;
  const eps = numOrUndef(q.eps); if (eps !== undefined) row.eps = eps;
  const beta = numOrUndef(q.beta); if (beta !== undefined) row.beta = beta;
  const dy = numOrUndef(q.dividendYield); if (dy !== undefined) row.dividendYield = dy;
  const hi = numOrUndef(q.fiftyTwoWeekHigh); if (hi !== undefined) row.week52High = hi;
  const lo = numOrUndef(q.fiftyTwoWeekLow); if (lo !== undefined) row.week52Low = lo;
  const fcf = numOrUndef(q.fcfYield); if (fcf !== undefined) row.fcfYield = fcf;
  const de = numOrUndef(q.debtToEquity); if (de !== undefined) row.debtToEquity = de;
  const eg = numOrUndef(q.epsGrowth); if (eg !== undefined) row.epsGrowth = eg;
  // Only the ticker+date keys present → nothing real to share.
  return Object.keys(row).length > 2 ? row : null;
}

/**
 * Map a scanned MarketQuote's analyst consensus to App A's import row (PR #46). Blends the per-source
 * rating counts App B holds; App B has no price targets, so those are omitted (App A fills null).
 */
export function marketQuoteToAnalyst(
  q: Pick<MarketQuote, "symbol" | "analystRating" | "analystBySource">,
  date: string
): CongressAnalyst | null {
  const ticker = normalizeSymbol(q.symbol);
  if (!ticker) return null;
  const counts = { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 };
  let haveCounts = false;
  for (const detail of Object.values(q.analystBySource ?? {})) {
    if (!detail?.counts) continue;
    haveCounts = true;
    counts.strongBuy += detail.counts.strongBuy ?? 0;
    counts.buy += detail.counts.buy ?? 0;
    counts.hold += detail.counts.hold ?? 0;
    counts.sell += detail.counts.sell ?? 0;
    counts.strongSell += detail.counts.strongSell ?? 0;
  }
  if (!q.analystRating && !haveCounts) return null;
  const row: CongressAnalyst = { ticker, date };
  if (q.analystRating) row.rating = q.analystRating;
  if (haveCounts) Object.assign(row, counts);
  return row;
}

/** Convert OHLC bars to deduped, date-sorted {date, close, volume?} closes (drops invalid bars). */
export function ohlcBarsToCloses(bars: OHLCBar[] | null | undefined): CongressClose[] {
  if (!bars || bars.length === 0) return [];
  const byDate = new Map<string, CongressClose>();
  for (const bar of bars) {
    const date = toBusinessDay(bar.time);
    const close = bar.close;
    if (!date || typeof close !== "number" || !Number.isFinite(close)) continue;
    const entry: CongressClose = { date, close };
    if (typeof bar.volume === "number" && Number.isFinite(bar.volume)) entry.volume = bar.volume;
    byDate.set(date, entry); // later bar for a given date wins
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // ascending
}

/** Build a per-ticker price entry from OHLC bars. currentPrice/currentPriceDate = most recent close. */
export function ohlcBarsToPriceEntry(symbol: string, bars: OHLCBar[] | null | undefined): CongressPrice | null {
  const ticker = normalizeSymbol(symbol);
  if (!ticker) return null;
  const closes = ohlcBarsToCloses(bars);
  if (closes.length === 0) return null;
  const newest = closes[closes.length - 1]; // closes are ascending
  return { ticker, closes, currentPrice: newest.close, currentPriceDate: newest.date };
}

// ── Insider / short-volume import builders (App B's highest-fit datasets for App A) ──

/** Build App A insider rows from App B's cached SEC Form-4 dataset; shares summed per symbol. */
export function buildInsiderImport(): CongressInsider[] {
  const ds = getInsiderDataset();
  if (!ds || ds.filings.length === 0) return [];
  const agg = new Map<string, { buyShares: number; sellShares: number; date: string }>();
  for (const f of ds.filings) {
    const sym = normalizeSymbol(f.symbol);
    if (!sym) continue;
    const a = agg.get(sym) ?? { buyShares: 0, sellShares: 0, date: f.filedAt };
    a.buyShares += f.buyShares;
    a.sellShares += f.sellShares;
    if (f.filedAt > a.date) a.date = f.filedAt;
    agg.set(sym, a);
  }
  const symbols = Array.from(agg.keys());
  const signals = getInsiderSignals(symbols);
  const out: CongressInsider[] = [];
  for (const sym of symbols) {
    const sig = signals[sym];
    const a = agg.get(sym);
    if (!sig || !a) continue;
    out.push({
      ticker: sym,
      date: a.date,
      sentiment: sig.insiderSentiment,
      buyFilings: sig.buyFilings,
      sellFilings: sig.sellFilings,
      buyShares: a.buyShares,
      sellShares: a.sellShares,
      owners: sig.owners
    });
  }
  return out.slice(0, maxDailyTickers());
}

/** Build App A short-volume rows from App B's cached FINRA dataset. */
export function buildShortVolumeImport(): CongressShortVol[] {
  const ds = getFinraDataset();
  const symbols = ds ? Object.keys(ds.ratios) : [];
  if (symbols.length === 0) return [];
  const signals = getShortVolumeSignals(symbols);
  const out: CongressShortVol[] = [];
  for (const sym of symbols) {
    const sig = signals[sym];
    if (!sig) continue;
    const date = sig.asOf ?? ds?.asOf;
    if (!date) continue;
    out.push({ ticker: sym, date, ratio: sig.shortVolumeRatio, elevated: sig.elevated });
  }
  return out.slice(0, maxDailyTickers());
}

// ── Low-level POST ─────────────────────────────────────────────────────────────

function countCloses(payload: CongressSharePayload): number {
  let n = (payload.spx?.length ?? 0);
  for (const p of payload.prices ?? []) n += p.closes.length;
  return n;
}

/**
 * POST one payload to App A's import endpoint. Idempotent + safe to resend. Self-guarded: never
 * throws — returns a structured result (skipped when no token; ok:false on transport/HTTP error).
 */
export async function shareWithCongressTrade(payload: CongressSharePayload): Promise<CongressShareResult> {
  const sent = {
    refs: payload.refs?.length ?? 0,
    spx: payload.spx?.length ?? 0,
    prices: payload.prices?.length ?? 0,
    closes: countCloses(payload),
    insider: payload.insider?.length ?? 0,
    shortVolume: payload.shortVolume?.length ?? 0,
    fundamentals: payload.fundamentals?.length ?? 0,
    analyst: payload.analyst?.length ?? 0
  };
  const token = congressTradeToken();
  if (!token) return { ok: false, skipped: true, reason: "no-token", sent };
  const total = sent.refs + sent.spx + sent.prices + sent.insider + sent.shortVolume + sent.fundamentals + sent.analyst;
  if (total === 0) {
    return { ok: false, skipped: true, reason: "empty", sent };
  }

  const url = `${congressTradeBaseUrl()}${IMPORT_PATH}`;
  const timeoutMs = Number(process.env.CONGRESS_SHARE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store"
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[congress-share] import failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      return { ok: false, status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}`, sent };
    }
    const response = await res.json().catch(() => undefined);
    return { ok: true, status: res.status, response, sent };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[congress-share] import error:", error);
    return { ok: false, error, sent };
  } finally {
    clearTimeout(timer);
  }
}

// ── Chunking ────────────────────────────────────────────────────────────────────

/**
 * Greedily pack price entries into POST-sized chunks bounded by BOTH a close budget and a ticker
 * count. A single ticker carrying more closes than the budget is sent alone (truncating its history
 * to the most-recent `CLOSE_BUDGET_PER_POST` closes so one POST always stays under the ceiling).
 */
export function chunkPrices(
  prices: CongressPrice[],
  closeBudget = CLOSE_BUDGET_PER_POST,
  maxTickers = MAX_TICKERS_PER_POST
): CongressPrice[][] {
  const chunks: CongressPrice[][] = [];
  let current: CongressPrice[] = [];
  let closesInChunk = 0;
  for (const price of prices) {
    let entry = price;
    if (entry.closes.length > closeBudget) {
      const trimmed = entry.closes.slice(-closeBudget);
      entry = { ...entry, closes: trimmed };
    }
    const wouldExceedCloses = closesInChunk + entry.closes.length > closeBudget && current.length > 0;
    const wouldExceedTickers = current.length >= maxTickers;
    if (wouldExceedCloses || wouldExceedTickers) {
      chunks.push(current);
      current = [];
      closesInChunk = 0;
    }
    current.push(entry);
    closesInChunk += entry.closes.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Scan-refs forwarding (after each scan) ──────────────────────────────────────

// Per-symbol throttle so frequent scans don't re-POST the same refs. globalThis-pinned so Next.js
// HMR module duplication can't reset it (mirrors the scheduler's stop-monitor guard).
const refGuardHost = globalThis as unknown as { __congressRefSentAt?: Map<string, number> };
const refSentAt: Map<string, number> = refGuardHost.__congressRefSentAt ?? (refGuardHost.__congressRefSentAt = new Map());

/**
 * Forward the scan's candidate company refs — plus the fundamentals + analyst consensus App B just
 * fetched for them — to App A. The scan already paid for this data, so sharing it lets App A skip its
 * own FMP calls (PR #46 import slots). Fire-and-forget friendly + self-guarded; no-op unless automatic
 * sharing is enabled; per-symbol throttled (default 6h) so it never spams. Fundamentals/analyst land
 * only once App A's #46 migration is live (extra keys are ignored before then — safe to send now).
 */
export async function shareScanRefs(scan: Pick<MarketScan, "topCandidates">): Promise<CongressShareResult | null> {
  try {
    if (!isCongressShareAutoEnabled()) return null;
    const now = Date.now();
    const ttl = refTtlMs();
    const date = utcDate(now);
    const refs: CongressRef[] = [];
    const fundamentals: CongressFundamental[] = [];
    const analyst: CongressAnalyst[] = [];
    const claimed: string[] = [];
    for (const quote of scan.topCandidates ?? []) {
      const ref = marketQuoteToRef(quote);
      if (!ref) continue;
      const sentAt = refSentAt.get(ref.ticker);
      if (sentAt !== undefined && now - sentAt < ttl) continue; // throttled
      refs.push(ref);
      const f = marketQuoteToFundamentals(quote, date);
      if (f) fundamentals.push(f);
      const a = marketQuoteToAnalyst(quote, date);
      if (a) analyst.push(a);
      claimed.push(ref.ticker);
      // Optimistically claim BEFORE the await so concurrent scans don't double-POST the same ref.
      refSentAt.set(ref.ticker, now);
      if (refs.length >= MAX_REFS_PER_POST) break;
    }
    if (refs.length === 0) return null;
    const result = await shareWithCongressTrade({ refs, fundamentals, analyst });
    if (!result.ok) {
      // Roll back the throttle so a later scan retries the failed refs (don't spam on success).
      for (const ticker of claimed) refSentAt.delete(ticker);
    }
    return result;
  } catch (err) {
    console.error("[congress-share] shareScanRefs error:", err);
    return null;
  }
}

/** Test seam: reset the in-memory scan-refs throttle. */
export function resetCongressRefThrottle(): void {
  refSentAt.clear();
}

// ── Nightly daily-close + S&P-500 batch ─────────────────────────────────────────

/** UTC calendar date (YYYY-MM-DD) for the given epoch ms. */
function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** True when the once-per-day batch has not yet run for `now`'s UTC date. Pure (no env gate). */
export function isCongressDailyShareDue(now: number): boolean {
  const last = getInternalSetting<string>(LAST_DAILY_RUN_KEY);
  return last !== utcDate(now);
}

/** Union of every user's watchlist symbols + policy-universe symbols (what this app monitors). */
function collectMonitoredSymbols(): string[] {
  const set = new Set<string>();
  for (const userId of listUsers()) {
    try {
      const policy = getPolicy(userId);
      for (const s of symbolsForPolicyUniverse(policy)) {
        const sym = normalizeSymbol(s);
        if (sym) set.add(sym);
      }
      for (const item of listWatchlistSymbols(userId)) {
        const sym = normalizeSymbol(item.symbol);
        if (sym) set.add(sym);
      }
    } catch {
      // one user's DB error must not block the others
    }
  }
  return Array.from(set);
}

/** Bounded-concurrency async map (gentle on the upstream history providers). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RunCongressDailyShareOptions {
  now?: number;
  /** Bypass the once-per-day date gate (the admin/manual path passes true). */
  force?: boolean;
  /** Override the universe (admin targeted test). When set, the date marker is NOT advanced. */
  symbols?: string[];
}

export interface CongressDailyShareSummary {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  tickers: number;
  priced: number;
  spxRows: number;
  insiderRows: number;
  shortVolRows: number;
  posts: number;
  failedPosts: number;
  sent: { spx: number; prices: number; closes: number; insider: number; shortVolume: number };
  responses?: unknown[];
}

/**
 * Collect the monitored universe's daily closes + the S&P-500 (^GSPC) series and POST them to App A
 * in capped chunks. Reuses the app's history cache, so a name fetched earlier in the day is free.
 * Self-guarded; safe to fire-and-forget. The scheduler calls the gated wrapper below; the admin
 * route calls this with force:true.
 */
export async function runCongressDailyShare(options: RunCongressDailyShareOptions = {}): Promise<CongressDailyShareSummary> {
  const now = options.now ?? Date.now();
  const empty = {
    tickers: 0, priced: 0, spxRows: 0, insiderRows: 0, shortVolRows: 0,
    posts: 0, failedPosts: 0, sent: { spx: 0, prices: 0, closes: 0, insider: 0, shortVolume: 0 }
  };
  if (!congressTradeToken()) return { ok: false, skipped: true, reason: "no-token", ...empty };

  const customUniverse = Array.isArray(options.symbols) && options.symbols.length > 0;
  if (!options.force && !customUniverse && !isCongressDailyShareDue(now)) {
    return { ok: false, skipped: true, reason: "not-due", ...empty };
  }

  const universe = (customUniverse ? options.symbols! : collectMonitoredSymbols())
    .map(normalizeSymbol)
    .filter(Boolean)
    .slice(0, maxDailyTickers());

  // S&P-500 daily closes (^GSPC) — sent once per day regardless of the ticker universe.
  let spx: CongressClose[] = [];
  try {
    spx = ohlcBarsToCloses(await fetchDailyOHLC("^GSPC", now));
  } catch (err) {
    console.error("[congress-share] SPX fetch failed:", err);
  }

  const concurrency = Number(process.env.CONGRESS_SHARE_CONCURRENCY ?? 4) || 4;
  const priceEntries = (
    await mapPool(universe, concurrency, async (symbol) => {
      try {
        return ohlcBarsToPriceEntry(symbol, await fetchDailyOHLC(symbol, now));
      } catch {
        return null;
      }
    })
  ).filter((p): p is CongressPrice => p !== null);

  // App B's two highest-fit datasets for congress.trade — already cached locally, sent once/day.
  const insider = customUniverse ? [] : buildInsiderImport();
  const shortVolume = customUniverse ? [] : buildShortVolumeImport();

  // POST: the first chunk carries the SPX series + insider + short-volume (one fewer round-trip);
  // remaining chunks are prices only.
  const chunks = chunkPrices(priceEntries);
  const head: CongressSharePayload = { spx, insider, shortVolume };
  const payloads: CongressSharePayload[] =
    chunks.length === 0
      ? spx.length > 0 || insider.length > 0 || shortVolume.length > 0
        ? [head]
        : []
      : chunks.map((prices, i) => (i === 0 ? { ...head, prices } : { prices }));

  const responses: unknown[] = [];
  let posts = 0;
  let failedPosts = 0;
  const sent = { spx: 0, prices: 0, closes: 0, insider: 0, shortVolume: 0 };
  for (const payload of payloads) {
    const result = await shareWithCongressTrade(payload);
    posts++;
    if (result.ok) {
      responses.push(result.response);
      sent.spx += result.sent.spx;
      sent.prices += result.sent.prices;
      sent.closes += result.sent.closes;
      sent.insider += result.sent.insider;
      sent.shortVolume += result.sent.shortVolume;
    } else if (!result.skipped) {
      failedPosts++;
    }
  }

  const ok = posts > 0 && failedPosts === 0;
  // Advance the once-per-day marker only for the real scheduled universe (not admin custom-symbol tests).
  if (ok && !customUniverse) {
    try {
      setInternalSetting(LAST_DAILY_RUN_KEY, utcDate(now));
    } catch (err) {
      console.error("[congress-share] failed to persist daily-run marker:", err);
    }
  }

  const summary: CongressDailyShareSummary = {
    ok,
    tickers: universe.length,
    priced: priceEntries.length,
    spxRows: spx.length,
    insiderRows: insider.length,
    shortVolRows: shortVolume.length,
    posts,
    failedPosts,
    sent,
    responses
  };
  try {
    audit("congress_share_daily", {
      ok,
      reason: posts === 0 ? "nothing-to-send" : undefined,
      tickers: summary.tickers,
      priced: summary.priced,
      spxRows: summary.spxRows,
      insiderRows: summary.insiderRows,
      shortVolRows: summary.shortVolRows,
      posts,
      failedPosts,
      sent,
      custom: customUniverse
    });
  } catch {
    // audit is best-effort
  }
  return summary;
}

/**
 * Scheduler entry point: run the nightly batch at most once per UTC day, only when automatic
 * sharing is enabled. Self-guarded; returns null when disabled/not due so the tick stays clean.
 */
export async function runCongressDailyShareIfDue(now: number = Date.now()): Promise<CongressDailyShareSummary | null> {
  try {
    if (!isCongressShareAutoEnabled()) return null;
    if (!isCongressDailyShareDue(now)) return null;
    return await runCongressDailyShare({ now });
  } catch (err) {
    console.error("[congress-share] daily batch error:", err);
    return null;
  }
}
