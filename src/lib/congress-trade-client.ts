import type { SecurityRef } from "@jaywedgeworth22/congress-trading-shared";
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

import type {
  TransactionsPage,
  TransactionsQuery,
  FundamentalRow,
  AnalystRow,
  TickerLeader,
  ClusterBuy,
  MemberLeader,
  MemberPerformance,
  ConvictionTicker,
  BacktestHorizon,
  TickerBacktest,
  CommitteeConflict,
  PriceClose,
  PriceSeries,
} from "@jaywedgeworth22/congress-trading-shared";
import { TransactionsPageSchema } from "@jaywedgeworth22/congress-trading-shared";

import type { OHLCBar } from "./indicators";
import { normalizeSymbol } from "./money";
import { logApiHealth } from "./db-health";

const DEFAULT_BASE_URL = "https://congress.trade";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface AppABundle {
  ref: SecurityRef | null;
  prices: PriceSeries | null;
  spx: PriceClose[];
}

// Re-export shared types under the names congress-trade-client consumers expect.
export type AppATransactionsPage = TransactionsPage;
export type AppATransactionsQuery = TransactionsQuery;
export type AppAFundamental = FundamentalRow & { source?: string | null; updatedAt?: string };
export type AppAAnalyst = AnalystRow & { analystCount?: number | null; source?: string | null; updatedAt?: string };
export type AppATickerLeader = TickerLeader;
export type AppAClusterRow = ClusterBuy;
export type AppAMemberRow = MemberLeader;
export type AppAMemberPerformance = MemberPerformance;
export type AppAConvictionTicker = ConvictionTicker;
export type AppABacktestHorizon = BacktestHorizon;
export type AppATickerBacktest = TickerBacktest;
export type AppAConflict = CommitteeConflict;

import { CongressTradeClient } from "@jaywedgeworth22/congress-trading-shared";

function baseUrl(): string {
  return (process.env.CONGRESS_TRADE_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function flagOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function congressReadsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_READS_ENABLED);
}

export function congressFundamentalsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED);
}

export function congressAsCongressSourceEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE);
}

export function congressAnalyticsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_ANALYTICS_ENABLED);
}

function readToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_READ_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function timeoutMs(): number {
  const v = Number(process.env.CONGRESS_TRADE_READ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

function getSharedClient(): CongressTradeClient {
  return new CongressTradeClient({
    baseUrl: baseUrl(),
    token: readToken(),
    fetch: async (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs());
      const start = Date.now();
      try {
        const res = await fetch(input, {
          ...init,
          signal: controller.signal,
          cache: "no-store"
        });
        logApiHealth({ service: "congress.trade", ok: res.ok, latencyMs: Date.now() - start, errorText: res.ok ? undefined : `HTTP ${res.status}` });
        return res;
      } catch (err) {
        logApiHealth({ service: "congress.trade", ok: false, latencyMs: Date.now() - start, errorText: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

export async function getAppABundle(ticker: string, opts?: { from?: string; to?: string }): Promise<AppABundle | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  try {
    const res = await getSharedClient().getBundle(sym, opts);
    return {
      ref: res.ref,
      prices: res.prices,
      spx: Array.isArray(res.spx) ? res.spx : []
    };
  } catch {
    return null;
  }
}

export async function getAppARef(ticker: string): Promise<SecurityRef | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  try { return await getSharedClient().getRef(sym); } catch { return null; }
}

export async function getAppARefs(tickers: string[]): Promise<SecurityRef[]> {
  if (!congressReadsEnabled()) return [];
  const syms = Array.from(new Set(tickers.map(normalizeSymbol).filter(Boolean)));
  if (syms.length === 0) return [];
  try { return await getSharedClient().getRefs(syms); } catch { return []; }
}

export async function getAppAPrices(ticker: string, opts?: { from?: string; to?: string }): Promise<PriceSeries | null> {
  if (!congressReadsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  try { return await getSharedClient().getPrices(sym, opts); } catch { return null; }
}

export async function getAppASpx(opts?: { from?: string; to?: string }): Promise<PriceClose[]> {
  if (!congressReadsEnabled()) return [];
  try { return await getSharedClient().getSpx(opts); } catch { return []; }
}

export async function getAppAFundamentals(ticker: string, opts?: { from?: string; to?: string }): Promise<AppAFundamental[]> {
  if (!congressFundamentalsEnabled()) return [];
  const sym = normalizeSymbol(ticker);
  if (!sym) return [];
  try { return await getSharedClient().getFundamentals(sym, opts); } catch { return []; }
}

export async function getAppAAnalyst(ticker: string, opts?: { from?: string; to?: string }): Promise<AppAAnalyst[]> {
  if (!congressFundamentalsEnabled()) return [];
  const sym = normalizeSymbol(ticker);
  if (!sym) return [];
  try { return await getSharedClient().getAnalyst(sym, opts); } catch { return []; }
}

export async function getAppATransactions(query: AppATransactionsQuery = {}): Promise<AppATransactionsPage | null> {
  if (!congressAsCongressSourceEnabled()) return null;
  try {
    const res = await getSharedClient().getTransactions(query);
    const parsed = TransactionsPageSchema.safeParse(res);
    if (!parsed.success) {
      console.warn("[congress-trade-client] transactions page validation failed:", parsed.error.flatten());
    }
    return res;
  } catch {
    return null;
  }
}

export async function getAppATickerLeaderboard(opts: { window?: string; limit?: number } = {}): Promise<AppATickerLeader[]> {
  if (!congressAnalyticsEnabled()) return [];
  try { return await getSharedClient().getTickerLeaderboard(opts); } catch { return []; }
}

export async function getAppAClusterBuys(opts: { window?: string; limit?: number } = {}): Promise<AppAClusterRow[]> {
  if (!congressAnalyticsEnabled()) return [];
  try { return await getSharedClient().getClusterBuys(opts); } catch { return []; }
}

export async function getAppAMemberLeaderboard(opts: { window?: string; limit?: number } = {}): Promise<AppAMemberRow[]> {
  if (!congressAnalyticsEnabled()) return [];
  try { return await getSharedClient().getMemberLeaderboard(opts); } catch { return []; }
}

export async function getAppAMemberPerformance(filerId: string): Promise<AppAMemberPerformance | null> {
  if (!congressAnalyticsEnabled() || !filerId) return null;
  try { return await getSharedClient().getMemberPerformance(filerId); } catch { return null; }
}

export function appAClosesToBars(closes: PriceClose[] | null | undefined): OHLCBar[] {
  if (!closes || closes.length === 0) return [];
  return closes
    .filter((c) => c && typeof c.close === "number" && Number.isFinite(c.close) && typeof c.date === "string")
    .map((c) => ({
      time: c.date,
      close: c.close,
      ...(typeof c.volume === "number" && Number.isFinite(c.volume) ? { volume: c.volume } : {})
    }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

export async function getAppAConviction(opts: { window?: string; limit?: number } = {}): Promise<AppAConvictionTicker[]> {
  if (!congressAnalyticsEnabled()) return [];
  try { return await getSharedClient().getConviction(opts); } catch { return []; }
}

export async function getAppATickerBacktest(
  ticker: string,
  opts: { window?: string; horizons?: string; filerId?: string } = {}
): Promise<AppATickerBacktest | null> {
  if (!congressAnalyticsEnabled()) return null;
  const sym = normalizeSymbol(ticker);
  if (!sym) return null;
  try { return await getSharedClient().getTickerBacktest(sym, opts); } catch { return null; }
}

export async function getAppAConflicts(
  opts: { window?: string; limit?: number; chamber?: string; party?: string } = {}
): Promise<AppAConflict[]> {
  if (!congressAnalyticsEnabled()) return [];
  try { return await getSharedClient().getConflicts(opts); } catch { return []; }
}
