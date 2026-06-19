// Congressional trade ingestion.
//
// Politicians disclose stock trades on a delay (up to ~45 days). When a disclosure
// lands, copycat retail flow often follows — so surfacing fresh disclosures to the
// agent lets it act on the same names before the copycats pile in.
//
// There is no reliable FREE key-based API for this, so we read it from public
// sources, in priority order:
//   1. Senate eFD  (efdsearch.senate.gov) — authoritative, free, no key. Validated
//      live: CSRF -> accept terms -> POST report search -> parse each PTR's table.
//   2. Capitol Trades BFF (bff.capitoltrades.com) — public JSON back-end covering
//      House + Senate. Configurable + best-effort (their CloudFront is flaky).
//
// All adapters degrade to nothing on failure — we never invent a trade.

import { audit, getInternalSetting, setInternalSetting } from "../db";
import { normalizeSymbol } from "../money";
import type { CongressSignal, CongressTrade } from "./types";
import {
  BROWSER_UA,
  cookieHeader,
  mergeSetCookies,
  politeFetch,
  politeFetchText,
  runRateLimited
} from "./http";

const DATASET_KEY = "webSource:congress:dataset";
const ATTEMPT_KEY = "webSource:congress:lastAttempt";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily; congressional disclosures trickle in every day
const DEFAULT_RETRY_BACKOFF_MS = 60 * 60_000; // wait 1h before retrying after a failed/empty scrape
const DEFAULT_WINDOW_DAYS = 60; // how far back a trade still counts toward the signal
const DEFAULT_LOOKBACK_DAYS = 45; // how far back to pull new filings each refresh
const DEFAULT_MAX_FILINGS = 80; // cap PTR pages fetched per refresh (politeness)
const EFD_BASE = "https://efdsearch.senate.gov";
const DEFAULT_CAPITOL_TRADES_URL = "https://bff.capitoltrades.com/trades?per_page=100&page=1&sortBy=-txDate";

export interface CongressDataset {
  trades: CongressTrade[];
  fetchedAt: string;
  sources: string[];
  recordCount: number;
}

export function congressTtlMs(): number {
  const v = Number(process.env.WEB_SOURCE_CONGRESS_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function windowDays(): number {
  const v = Number(process.env.WEB_SOURCE_CONGRESS_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_DAYS;
}

export function getCongressDataset(): CongressDataset | undefined {
  return getInternalSetting<CongressDataset>(DATASET_KEY);
}

// ── Pure parsers (unit-tested without network) ───────────────────────────────

const TICKER_RE = /^[A-Z][A-Z.\-]{0,5}$/;

/** Parse a disclosed dollar range like "$1,001 - $15,000" into numeric bounds. */
export function parseAmountRange(text: string): { amountLow?: number; amountHigh?: number } {
  const nums = (text.match(/\$[\d,]+/g) ?? []).map((s) => Number(s.replace(/[$,]/g, ""))).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return {};
  if (nums.length === 1) return { amountLow: nums[0], amountHigh: nums[0] };
  return { amountLow: nums[0], amountHigh: nums[1] };
}

function toIsoDate(mdy: string): string | undefined {
  const m = mdy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  // Range-validate so a corrupt source date (e.g. "13/45/2026") falls through to a
  // fallback instead of producing "2026-13-45", which Date.parse() reads as NaN and
  // then silently slips past the recency-window guard in aggregateCongressSignals.
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface EfdFiling {
  member: string;
  viewUrl: string;
  isPtr: boolean;
  filedAt?: string;
}

/** Parse the DataTables JSON returned by /search/report/data/ into filing rows. */
export function parseEfdReportRows(json: unknown): EfdFiling[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const filings: EfdFiling[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const first = stripTags(String(row[0] ?? ""));
    const last = stripTags(String(row[1] ?? ""));
    const linkCell = String(row[3] ?? "");
    const hrefMatch = linkCell.match(/href=["']([^"']+)["']/);
    const href = hrefMatch?.[1];
    if (!href) continue;
    const filedAt = toIsoDate(stripTags(String(row[4] ?? "")));
    filings.push({
      member: `${first} ${last}`.replace(/\s+/g, " ").trim(),
      viewUrl: href.startsWith("http") ? href : `${EFD_BASE}${href}`,
      isPtr: href.includes("/view/ptr/"),
      filedAt
    });
  }
  return filings;
}

/**
 * Parse the transactions table from an e-filed PTR view page. Classifies each cell
 * by content (ticker / date / amount / type) rather than fixed column index, so the
 * parser survives column reordering in the source HTML.
 */
export function parsePtrTransactions(html: string, ctx: { member: string; filedAt?: string }): CongressTrade[] {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbody) return [];
  const rowChunks = tbody[1].split(/<tr[^>]*>/i).slice(1);
  const trades: CongressTrade[] = [];
  for (const chunk of rowChunks) {
    const cells = (chunk.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripTags(c));
    if (cells.length < 5) continue;

    // Anchor the ticker to its fixed eFD column (4th cell:
    // [#, txDate, owner, ticker, assetName, assetType, txType, amount, comment]).
    // A row-wide search would mis-grab an all-caps asset-name token (e.g. "GOLD")
    // when the ticker cell is "--" for a non-equity holding, fabricating a trade.
    const ticker = cells[3];
    if (!ticker || ticker === "--" || !TICKER_RE.test(ticker)) continue;

    const typeCell = cells.find((c) => /\b(purchase|sale|exchange)\b/i.test(c));
    if (!typeCell) continue;
    let side: "buy" | "sell";
    if (/purchase/i.test(typeCell)) side = "buy";
    else if (/sale/i.test(typeCell)) side = "sell";
    else continue; // exchanges aren't directional

    const amountCell = cells.find((c) => /\$[\d,]+/.test(c)) ?? "";
    // First date-looking cell that isn't the future-dated nothing; tx date precedes filing.
    const dateCell = cells.map((c) => toIsoDate(c)).find(Boolean);

    trades.push({
      symbol: normalizeSymbol(ticker),
      member: ctx.member,
      chamber: "senate",
      side,
      ...parseAmountRange(amountCell),
      tradedAt: dateCell ?? ctx.filedAt ?? new Date().toISOString().slice(0, 10),
      disclosedAt: ctx.filedAt,
      source: "senate-efd"
    });
  }
  return trades;
}

/** Parse Capitol Trades BFF JSON (best-effort; their field names have shifted over time). */
export function parseCapitolTradesBff(json: unknown): CongressTrade[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const trades: CongressTrade[] = [];
  for (const raw of data) {
    const row = raw as Record<string, any>;
    const ticker =
      row.asset?.assetTicker ?? row.assetTicker ?? row.ticker ?? row.issuer?.issuerTicker ?? row._stockTicker;
    if (!ticker || typeof ticker !== "string") continue;
    const sym = normalizeSymbol(ticker.split(":")[0]);
    if (!TICKER_RE.test(sym)) continue;
    const txType = String(row.txType ?? row.type ?? "").toLowerCase();
    let side: "buy" | "sell";
    if (/buy|purchase/.test(txType)) side = "buy";
    else if (/sell|sale|sold/.test(txType)) side = "sell";
    else continue;
    const pol = row.politician ?? {};
    const member =
      [pol.firstName, pol.lastName].filter(Boolean).join(" ").trim() ||
      String(row.politicianName ?? "").trim() ||
      "Unknown";
    const chamber: "senate" | "house" = /house|rep/i.test(String(pol.chamber ?? row.chamber ?? "")) ? "house" : "senate";
    const value = Number(row.value ?? row.size ?? NaN);
    trades.push({
      symbol: sym,
      member,
      chamber,
      side,
      ...(Number.isFinite(value) ? { amountLow: value, amountHigh: value } : {}),
      tradedAt: String(row.txDate ?? row.transactionDate ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
      disclosedAt: row.pubDate ? String(row.pubDate).slice(0, 10) : undefined,
      source: "capitol-trades"
    });
  }
  return trades;
}

// ── Aggregation (pure) ───────────────────────────────────────────────────────

/** Build per-symbol congressional signals for the requested symbols, within the window. */
export function aggregateCongressSignals(
  trades: CongressTrade[],
  symbols: string[],
  now: number = Date.now(),
  window = windowDays()
): Record<string, CongressSignal> {
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const cutoff = now - window * 24 * 60 * 60_000;
  const bySymbol = new Map<string, CongressTrade[]>();
  for (const t of trades) {
    if (!wanted.has(t.symbol)) continue;
    const ts = Date.parse(t.tradedAt || t.disclosedAt || "");
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  const out: Record<string, CongressSignal> = {};
  for (const [symbol, list] of bySymbol) {
    list.sort((a, b) => Date.parse(b.tradedAt) - Date.parse(a.tradedAt));
    const buyMembers = distinct(list.filter((t) => t.side === "buy").map((t) => t.member));
    const sellMembers = distinct(list.filter((t) => t.side === "sell").map((t) => t.member));
    const buyCount = list.filter((t) => t.side === "buy").length;
    const sellCount = list.filter((t) => t.side === "sell").length;
    out[symbol] = {
      netSignal: buyMembers.length - sellMembers.length,
      buyCount,
      sellCount,
      buyMembers,
      sellMembers,
      windowDays: window,
      lastTradedAt: list[0]?.tradedAt,
      bulletin: buildBulletin(symbol, buyMembers, sellMembers, buyCount, sellCount, window)
    };
  }
  return out;
}

function distinct(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function buildBulletin(
  symbol: string,
  buyMembers: string[],
  sellMembers: string[],
  buyCount: number,
  sellCount: number,
  window: number
): string {
  const names = (m: string[]) => m.slice(0, 3).join(", ") + (m.length > 3 ? `, +${m.length - 3} more` : "");
  if (buyCount > 0 && sellCount === 0) {
    return `Congress: ${buyMembers.length} member(s) disclosed BUYS of ${symbol} in the last ${window}d (${names(buyMembers)}); no sells.`;
  }
  if (sellCount > 0 && buyCount === 0) {
    return `Congress: ${sellMembers.length} member(s) disclosed SELLS of ${symbol} in the last ${window}d (${names(sellMembers)}); no buys.`;
  }
  return `Congress: mixed activity on ${symbol} in last ${window}d — ${buyCount} buy(s) by ${names(buyMembers)} vs ${sellCount} sell(s) by ${names(sellMembers)}.`;
}

/** Read the cached dataset and build signals for the given symbols (no network). */
export function getCongressSignals(symbols: string[], now: number = Date.now()): Record<string, CongressSignal> {
  const dataset = getCongressDataset();
  if (!dataset?.trades?.length) return {};
  return aggregateCongressSignals(dataset.trades, symbols, now);
}

// ── Live adapters ────────────────────────────────────────────────────────────

/**
 * Scrape recent Senate PTR disclosures. Multi-step Django flow:
 *   GET /search/ -> CSRF + cookies; POST /search/home/ (accept terms, token rotates);
 *   POST /search/report/data/ -> filings; GET each e-filed PTR -> parse table.
 */
export async function scrapeSenateEfd(now: number = Date.now()): Promise<CongressTrade[]> {
  const jar: Record<string, string> = {};
  const landing = await politeFetch(`${EFD_BASE}/search/`, { headers: { "user-agent": BROWSER_UA } });
  mergeSetCookies(jar, landing);
  const landingHtml = await landing.text();
  const formCsrf = landingHtml.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/)?.[1] ?? jar.csrftoken;
  if (!formCsrf) throw new Error("Senate eFD: no CSRF token");

  const acceptBody = new URLSearchParams({ prohibition_agreement: "1", csrfmiddlewaretoken: formCsrf });
  const accept = await politeFetch(`${EFD_BASE}/search/home/`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "user-agent": BROWSER_UA,
      "content-type": "application/x-www-form-urlencoded",
      referer: `${EFD_BASE}/search/`,
      cookie: cookieHeader(jar),
      "x-csrftoken": formCsrf
    },
    body: acceptBody
  });
  mergeSetCookies(jar, accept);
  const apiToken = jar.csrftoken ?? formCsrf; // token rotates after accepting terms

  const lookbackDays = Number(process.env.WEB_SOURCE_CONGRESS_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
  const from = new Date(now - lookbackDays * 24 * 60 * 60_000);
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  const searchBody = new URLSearchParams();
  searchBody.append("draw", "1");
  searchBody.append("start", "0");
  searchBody.append("length", "100");
  searchBody.append("report_types", "[11]"); // Periodic Transaction Reports
  searchBody.append("filer_types", "[]");
  searchBody.append("submitted_start_date", `${fmt(from)} 00:00:00`);
  searchBody.append("submitted_end_date", "");
  searchBody.append("candidate_state", "");
  searchBody.append("senator_state", "");
  searchBody.append("office_id", "");
  searchBody.append("first_name", "");
  searchBody.append("last_name", "");
  searchBody.append("csrfmiddlewaretoken", apiToken);

  const searchJson = await politeFetch(`${EFD_BASE}/search/report/data/`, {
    method: "POST",
    headers: {
      "user-agent": BROWSER_UA,
      "content-type": "application/x-www-form-urlencoded",
      referer: `${EFD_BASE}/search/`,
      cookie: cookieHeader(jar),
      "x-csrftoken": apiToken,
      "x-requested-with": "XMLHttpRequest"
    },
    body: searchBody
  });
  if (!searchJson.ok) throw new Error(`Senate eFD search HTTP ${searchJson.status}`);
  const filings = parseEfdReportRows(await searchJson.json())
    .filter((f) => f.isPtr)
    .slice(0, Number(process.env.WEB_SOURCE_CONGRESS_MAX_FILINGS ?? DEFAULT_MAX_FILINGS));

  const perFiling = await runRateLimited(filings, 350, async (filing) => {
    try {
      const html = await politeFetchText(filing.viewUrl, {
        headers: { "user-agent": BROWSER_UA, cookie: cookieHeader(jar), referer: `${EFD_BASE}/search/` }
      });
      return parsePtrTransactions(html, { member: filing.member, filedAt: filing.filedAt });
    } catch {
      return [] as CongressTrade[];
    }
  });
  return perFiling.flat();
}

/** Fetch Capitol Trades' public JSON back-end (best-effort; host can be configured/disabled). */
export async function fetchCapitolTrades(): Promise<CongressTrade[]> {
  const configured = process.env.WEB_SOURCE_CAPITOLTRADES_URL?.trim();
  if (configured && /^(off|false|disabled|none)$/i.test(configured)) return [];
  const base = configured || DEFAULT_CAPITOL_TRADES_URL;
  const res = await politeFetch(base, {
    headers: {
      "user-agent": BROWSER_UA,
      accept: "application/json",
      origin: "https://www.capitoltrades.com",
      referer: "https://www.capitoltrades.com/"
    }
  });
  if (!res.ok) throw new Error(`Capitol Trades HTTP ${res.status}`);
  return parseCapitolTradesBff(await res.json());
}

// ── Refresh orchestration ────────────────────────────────────────────────────

function dedupeTrades(trades: CongressTrade[]): CongressTrade[] {
  const seen = new Set<string>();
  const out: CongressTrade[] = [];
  for (const t of trades) {
    const key = `${t.symbol}|${t.member}|${t.side}|${t.tradedAt}|${t.amountLow ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function retryBackoffMs(): number {
  const v = Number(process.env.WEB_SOURCE_RETRY_BACKOFF_MS ?? DEFAULT_RETRY_BACKOFF_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETRY_BACKOFF_MS;
}

export function isCongressRefreshDue(now: number = Date.now()): boolean {
  // Back off briefly after ANY attempt so a failed scrape (which intentionally does
  // not advance the dataset's fetchedAt) doesn't re-fire on every 60s scheduler tick.
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  if (lastAttempt && now - Date.parse(lastAttempt) < retryBackoffMs()) return false;
  const dataset = getCongressDataset();
  if (!dataset?.fetchedAt) return true;
  return now - Date.parse(dataset.fetchedAt) >= congressTtlMs();
}

/**
 * Refresh the cached congressional dataset if it's stale. Runs Senate eFD first
 * (authoritative), then Capitol Trades (House coverage). Persists whatever was
 * gathered; on total failure leaves the previous dataset untouched (never wipes to
 * fake/empty mid-trading-day). Returns a result for auditing.
 */
export async function refreshCongress(now: number = Date.now(), force = false): Promise<import("./types").WebSourceRefreshResult> {
  if (!force && !isCongressRefreshDue(now)) {
    const ds = getCongressDataset();
    return { id: "congress", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds?.sources ?? [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }

  // Record the attempt up front so a failure backs off (retryBackoffMs) instead of
  // re-firing every tick; the dataset's fetchedAt still only advances on success.
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  const collected: CongressTrade[] = [];
  const sources: string[] = [];
  const warnings: string[] = [];

  for (const adapter of [
    { id: "senate-efd", run: () => scrapeSenateEfd(now) },
    { id: "capitol-trades", run: fetchCapitolTrades }
  ]) {
    try {
      const trades = await adapter.run();
      if (trades.length > 0) {
        collected.push(...trades);
        sources.push(adapter.id);
      }
    } catch (error) {
      warnings.push(`${adapter.id}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  const fetchedAt = new Date(now).toISOString();
  if (collected.length === 0) {
    // Don't overwrite a good prior dataset with nothing on a transient outage.
    const prior = getCongressDataset();
    audit("web_source_refresh", { id: "congress", ok: false, recordCount: 0, warnings });
    return { id: "congress", ok: false, recordCount: prior?.recordCount ?? 0, sources: prior?.sources ?? [], fetchedAt: prior?.fetchedAt ?? "", warning: warnings.join("; ") || "no records" };
  }

  const trades = dedupeTrades(collected);
  const dataset: CongressDataset = { trades, fetchedAt, sources, recordCount: trades.length };
  setInternalSetting(DATASET_KEY, dataset);
  audit("web_source_refresh", { id: "congress", ok: true, recordCount: trades.length, sources, warnings });
  return { id: "congress", ok: true, recordCount: trades.length, sources, fetchedAt, warning: warnings.join("; ") || undefined };
}
