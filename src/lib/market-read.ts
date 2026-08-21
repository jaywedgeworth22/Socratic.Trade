// Token-gated market-data READ side of the congress.trade (App A) price bridge.
//
// App B (this app) already PUSHES refs/prices/spx to App A (src/lib/congress-share.ts) and RECEIVES
// gap-fills back (app/api/admin/securities/import). These read endpoints complete the loop: they let
// App A PULL App B's daily EOD bars over HTTP (cache-aside), served in the exact PriceSeries /
// { closes } envelopes the shared CongressTradeClient parses
// (@jaywedgeworth22/congress-trading-shared: /api/market/prices/{ticker}, /api/market/spx).
//
// Auth lives in the route handlers (verifySecuritiesImportToken — the same APP_B_INGEST_TOKEN bearer
// secret as the import receiver); middleware only passes bearer requests through.
//
// Bars come from fetchDailyOHLC — the app's single daily-OHLC cascade (local imported-EOD tier →
// App A → Massive → Tradier → Marketstack → Yahoo → Stooq, briefly cached in-process). SPX is served
// as SPY daily bars — the benchmark convention the consumer already uses. Contract notes:
//   - closes are DESCENDING by date (newest first) — App A treats closes[0] as the latest close;
//   - from/to are optional, inclusive YYYY-MM-DD; an omitted `from` defaults to ~1y back, `to` to today;
//   - unknown symbols / empty ranges return 200 with empty closes (never an error status) so the
//     consumer only falls back to another provider on genuine non-200 failures.

import type { OHLCBar } from "./indicators";
import { fetchDailyOHLC } from "./history";
import { normalizeSymbol } from "./money";
import { ohlcBarsToCloses, type CongressClose, type CongressPrice } from "./congress-share";

/** Injectable daily-OHLC fetcher; the routes use the app's canonical cascade, tests inject canned bars. */
export type DailyOHLCFetcher = (symbol: string) => Promise<OHLCBar[] | null>;

/** Peer-serving default: the canonical cascade minus its App A read-back tier. A request App A
 *  itself originated must not be echoed back at App A — it asks precisely because its own series
 *  needs topping up, so the echo can only return the stale closes App A already holds (one
 *  guaranteed-wasted HTTP hop per cache miss, App A's route is read-only so the loop is 1-hop). */
const peerServingFetcher: DailyOHLCFetcher = (symbol) =>
  fetchDailyOHLC(symbol, Date.now(), undefined, { skipAppATier: true, usageLabel: "congress-read" });

/** Resolved inclusive YYYY-MM-DD bounds for a market read (defaults already applied). */
export interface MarketRange {
  from: string;
  to: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Default lookback when `from` is omitted — a sensible recent window (~1y of trading days). */
const DEFAULT_LOOKBACK_DAYS = 366;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse `from`/`to` query params (inclusive, YYYY-MM-DD). Missing/invalid values fall back to the
 *  default recent window — the read contract stays 200-with-data rather than failing on a bad param. */
export function parseMarketRange(url: string, now: Date = new Date()): MarketRange {
  const sp = new URL(url).searchParams;
  const rawFrom = sp.get("from");
  const rawTo = sp.get("to");
  const to = rawTo && ISO_DATE.test(rawTo) ? rawTo : isoDay(now);
  const from =
    rawFrom && ISO_DATE.test(rawFrom)
      ? rawFrom
      : isoDay(new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000));
  return { from, to };
}

/** Inclusive date-window filter; preserves the input order. */
export function closesInRange(closes: CongressClose[], from: string, to: string): CongressClose[] {
  return closes.filter((c) => c.date >= from && c.date <= to);
}

/**
 * Build the /api/market/prices/{ticker} envelope: closes DESCENDING within [from, to], plus
 * currentPrice/currentPriceDate taken from the newest close of the FULL series (range-independent, so
 * a historical-backfill response still reports the true latest). No bars → `{ ticker, closes: [] }`
 * with null currentPrice — a 200, never an error status (the consumer falls back on non-200 only).
 */
export async function fetchPriceSeries(
  rawSymbol: string,
  range: MarketRange,
  fetcher: DailyOHLCFetcher = peerServingFetcher
): Promise<CongressPrice> {
  const ticker = normalizeSymbol(rawSymbol);
  const bars = ticker ? await fetcher(ticker) : null;
  const ascending = ohlcBarsToCloses(bars); // deduped, date-ascending
  const closes = closesInRange(ascending, range.from, range.to).reverse(); // DESC — closes[0] is latest
  const newest = ascending[ascending.length - 1];
  return {
    ticker,
    closes,
    currentPrice: newest?.close ?? null,
    currentPriceDate: newest?.date ?? null
  };
}

/**
 * Build the /api/market/spx payload: SPY daily bars (the consumer's S&P 500 benchmark convention),
 * DESCENDING within [from, to]. Empty array when no bars are available.
 */
export async function fetchSpxCloses(
  range: MarketRange,
  fetcher: DailyOHLCFetcher = peerServingFetcher
): Promise<CongressClose[]> {
  const ascending = ohlcBarsToCloses(await fetcher("SPY"));
  return closesInRange(ascending, range.from, range.to).reverse();
}
