// SEC EDGAR insider (Form 4) ingestion.
//
// SEC EDGAR is free and authoritative but only requires a descriptive User-Agent
// (no key). There is no single market-wide feed that includes trade DIRECTION, so
// we read the "current Form 4" filings feed and parse each filing's ownership XML,
// keeping only OPEN-MARKET discretionary transactions:
//   P = open-market purchase (bullish), S = open-market sale (bearish).
// Codes like M (option exercise), A (grant/award), F (tax withholding), G (gift)
// are NOT trading signals and are deliberately ignored.
//
// Like the congress connector this is a low-frequency bulk job: each daily refresh
// captures the latest filings and merges them into a rolling window, so over time
// the dataset covers whichever symbols insiders actually traded — never fabricated.

import { audit, getInternalSetting, listUsers, listWatchlistSymbols, setInternalSetting } from "../db";
import { normalizeSymbol } from "../money";
import { resolveSourceBool, resolveSourceNumber } from "../source-settings";
import type { WebSourceRefreshResult } from "./types";
import { retryBackoffMs } from "./congress";
import { politeFetchText, runRateLimited, secUserAgent } from "./http";
import { parseAndSaveForm4 } from "./sec-facts";
import { loadTickerCikMap } from "./sec8k";
import { padCik } from "./sec-filings";

const DATASET_KEY = "webSource:insider:dataset";
const ATTEMPT_KEY = "webSource:insider:lastAttempt";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily
const DEFAULT_WINDOW_DAYS = 30; // how long an insider filing stays in the rolling window
const DEFAULT_MAX_FILINGS = 60; // ownership XMLs parsed per refresh (politeness: ~2 reqs each)
const SEC_BASE = "https://www.sec.gov";

export interface InsiderFiling {
  symbol: string;
  owner: string;
  buyTx: number; // count of open-market purchase transactions
  sellTx: number; // count of open-market sale transactions
  buyShares: number;
  sellShares: number;
  filedAt: string; // ISO date
  accession: string;
}

export interface InsiderDataset {
  filings: InsiderFiling[];
  fetchedAt: string;
  recordCount: number;
}

export interface InsiderSignal {
  insiderSentiment: number; // 0–100 (buy transactions as % of open-market P+S)
  buyFilings: number;
  sellFilings: number;
  owners: string[];
  windowDays: number;
  bulletin: string;
}

export function insiderTtlMs(): number {
  const fromSettings = resolveSourceNumber("WEB_SOURCE_INSIDER_TTL_MS");
  const v = fromSettings > 0 ? fromSettings : Number(process.env.WEB_SOURCE_INSIDER_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function windowDays(): number {
  const fromSettings = resolveSourceNumber("WEB_SOURCE_INSIDER_WINDOW_DAYS");
  const v = fromSettings > 0 ? fromSettings : Number(process.env.WEB_SOURCE_INSIDER_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_DAYS;
}

function maxFilings(): number {
  const fromSettings = resolveSourceNumber("WEB_SOURCE_INSIDER_MAX_FILINGS");
  const v = fromSettings > 0 ? fromSettings : Number(process.env.WEB_SOURCE_INSIDER_MAX_FILINGS ?? DEFAULT_MAX_FILINGS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_FILINGS;
}

export function getInsiderDataset(): InsiderDataset | undefined {
  return getInternalSetting<InsiderDataset>(DATASET_KEY);
}

// ── Pure parsers (unit-tested without network) ───────────────────────────────

/** Extract distinct filing folders + accession numbers from the current-Form-4 atom feed. */
export function parseCurrentForm4Feed(atomXml: string): Array<{ dir: string; accession: string }> {
  const out: Array<{ dir: string; accession: string }> = [];
  const seen = new Set<string>();
  for (const m of atomXml.matchAll(/href="([^"]*\/Archives\/edgar\/data\/[^"]*?index[^"]*)"/g)) {
    const link = m[1];
    const accession = link.match(/(\d{10}-\d{2}-\d{6})/)?.[1];
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);
    out.push({ dir: link.replace(/\/[^/]+$/, "/"), accession });
  }
  return out;
}

/** Pick the primary ownership XML from an EDGAR filing folder index.json. */
export function pickOwnershipXml(indexJson: unknown): string | undefined {
  const items = (indexJson as { directory?: { item?: Array<{ name?: string }> } })?.directory?.item;
  if (!Array.isArray(items)) return undefined;
  const names = items.map((i) => i?.name ?? "").filter(Boolean);
  // Prefer a primary ownership doc; exclude rendered/calc/label/schema sidecars.
  return (
    names.find((n) => /^(ownership|form4|primary_doc).*\.xml$/i.test(n)) ??
    names.find((n) => /\.xml$/i.test(n) && !/^R\d|(_|\b)(cal|def|lab|pre)\b|\.xsd$/i.test(n))
  );
}

/**
 * Validate an ISO filing date, REJECTING data-quality garbage. A Form 4 can't report a transaction
 * dated after today, so a future date (e.g. a corrupt "2026-12-26") is an unambiguous error — we
 * reject it rather than surface an impossible date in the UI or skew the recency window.
 */
function saneFilingDate(value: string | undefined, now: number = Date.now()): string | undefined {
  if (!value) return undefined;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Reject impossible calendar dates that would otherwise roll over to a valid timestamp (e.g.
  // "2026-02-30" -> Mar 2): build the UTC date from the components and require it to round-trip.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const ts = d.getTime();
  if (!Number.isFinite(ts)) return undefined;
  // A Form 4 reports a transaction that already happened, so its date is a timezone-less calendar
  // date that can't be after today — reject anything strictly future (no ±3-day skew; lexicographic
  // compare is valid for YYYY-MM-DD).
  const todayIso = new Date(now).toISOString().slice(0, 10);
  if (iso > todayIso) return undefined;
  if (ts < Date.parse("2000-01-01")) return undefined; // absurd past
  return iso;
}

/** Parse a Form 4 ownership XML into a normalized insider filing (open-market P/S only). */
export function parseForm4Xml(xml: string, ctx: { accession: string }): InsiderFiling | null {
  const symbolRaw = xml.match(/<issuerTradingSymbol>([\s\S]*?)<\/issuerTradingSymbol>/)?.[1]?.trim();
  if (!symbolRaw) return null;
  const symbol = normalizeSymbol(symbolRaw);
  if (!/^[A-Z][A-Z.\-]{0,5}$/.test(symbol)) return null;
  const owner = (xml.match(/<rptOwnerName>([\s\S]*?)<\/rptOwnerName>/)?.[1] ?? "Insider").replace(/\s+/g, " ").trim();
  // A date field that is SUPPLIED but future-dated or otherwise garbage is a data error — DROP the
  // filing rather than silently re-anchoring it to the signature date or today (which would surface
  // an impossible future transaction as current insider activity). Fall through only when a field is
  // simply absent; default to today only when no date was supplied at all.
  const periodRaw = xml.match(/<periodOfReport>([\s\S]*?)<\/periodOfReport>/)?.[1]?.trim();
  const sigRaw = xml.match(/<signatureDate>[\s\S]*?<value>([\s\S]*?)<\/value>/)?.[1]?.trim();
  const period = periodRaw ? saneFilingDate(periodRaw) : undefined;
  if (periodRaw && !period) return null;
  const sig = sigRaw ? saneFilingDate(sigRaw) : undefined;
  if (sigRaw && !sig) return null;
  const filedAt = period || sig || new Date().toISOString().slice(0, 10);

  let buyTx = 0;
  let sellTx = 0;
  let buyShares = 0;
  let sellShares = 0;
  // Only non-derivative open-market transactions carry directional sentiment.
  for (const block of xml.split(/<nonDerivativeTransaction>/).slice(1)) {
    const code = block.match(/<transactionCode>([A-Z])<\/transactionCode>/)?.[1];
    if (code !== "P" && code !== "S") continue;
    const shares = Number(block.match(/<transactionShares>[\s\S]*?<value>([\d.]+)<\/value>/)?.[1] ?? 0);
    if (code === "P") {
      buyTx++;
      buyShares += Number.isFinite(shares) ? shares : 0;
    } else {
      sellTx++;
      sellShares += Number.isFinite(shares) ? shares : 0;
    }
  }
  if (buyTx === 0 && sellTx === 0) return null; // no discretionary open-market activity
  return { symbol, owner, buyTx, sellTx, buyShares, sellShares, filedAt: filedAt.slice(0, 10), accession: ctx.accession };
}

// ── Aggregation (pure) ───────────────────────────────────────────────────────

export function aggregateInsiderSignals(
  filings: InsiderFiling[],
  symbols: string[],
  now: number = Date.now(),
  window = windowDays()
): Record<string, InsiderSignal> {
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const cutoff = now - window * 24 * 60 * 60_000;
  const bySymbol = new Map<string, InsiderFiling[]>();
  for (const f of filings) {
    if (!wanted.has(f.symbol)) continue;
    const ts = Date.parse(f.filedAt);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const list = bySymbol.get(f.symbol) ?? [];
    list.push(f);
    bySymbol.set(f.symbol, list);
  }

  const out: Record<string, InsiderSignal> = {};
  for (const [symbol, list] of bySymbol) {
    const buyTx = list.reduce((s, f) => s + f.buyTx, 0);
    const sellTx = list.reduce((s, f) => s + f.sellTx, 0);
    if (buyTx + sellTx === 0) continue;
    const buyFilings = list.filter((f) => f.buyTx > f.sellTx).length;
    const sellFilings = list.filter((f) => f.sellTx > f.buyTx).length;
    const owners = distinct(list.map((f) => f.owner));
    out[symbol] = {
      insiderSentiment: Math.round((buyTx / (buyTx + sellTx)) * 100),
      buyFilings,
      sellFilings,
      owners,
      windowDays: window,
      bulletin: buildInsiderBulletin(symbol, buyFilings, sellFilings, owners, window)
    };
  }
  return out;
}

function distinct(names: string[]): string[] {
  return Array.from(new Set(names.filter(Boolean)));
}

function buildInsiderBulletin(symbol: string, buyFilings: number, sellFilings: number, owners: string[], window: number): string {
  const who = owners.slice(0, 2).join(", ") + (owners.length > 2 ? `, +${owners.length - 2}` : "");
  if (buyFilings > 0 && sellFilings === 0) {
    return `Insider: ${buyFilings} open-market BUY filing(s) on ${symbol} in last ${window}d (${who}); no sells.`;
  }
  if (sellFilings > 0 && buyFilings === 0) {
    return `Insider: ${sellFilings} open-market SELL filing(s) on ${symbol} in last ${window}d (${who}); no buys.`;
  }
  return `Insider: mixed open-market activity on ${symbol} in last ${window}d — ${buyFilings} buy vs ${sellFilings} sell filing(s) (${who}).`;
}

export function getInsiderSignals(symbols: string[], now: number = Date.now()): Record<string, InsiderSignal> {
  const dataset = getInsiderDataset();
  if (!dataset?.filings?.length) return {};
  return aggregateInsiderSignals(dataset.filings, symbols, now);
}

// ── Live refresh ─────────────────────────────────────────────────────────────

export function isInsiderRefreshDue(now: number = Date.now()): boolean {
  // Back off after any attempt so a failed scrape doesn't re-fire every scheduler tick.
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  if (lastAttempt && now - Date.parse(lastAttempt) < retryBackoffMs()) return false;
  const dataset = getInsiderDataset();
  if (!dataset?.fetchedAt) return true;
  return now - Date.parse(dataset.fetchedAt) >= insiderTtlMs();
}

function cikFromEdgarDir(dir: string): string {
  const raw = dir.match(/\/data\/(\d+)\//)?.[1] ?? "";
  return raw ? padCik(raw) : "";
}

function persistForm4Xml(xml: string, dir: string, accession: string, parsed: InsiderFiling | null): void {
  const cik =
    xml.match(/<issuerCik>([^<]+)<\/issuerCik>/)?.[1]?.trim() ||
    cikFromEdgarDir(dir);
  if (!cik) return;
  try {
    parseAndSaveForm4(xml, cik, accession, parsed?.symbol ?? "");
  } catch {
    // Structured persist is additive; sentiment dataset still stores the filing.
  }
}

async function fetchForm4FromDirs(
  filings: Array<{ dir: string; accession: string }>,
  ua: string
): Promise<InsiderFiling[]> {
  const parsed = await runRateLimited(filings, 250, async ({ dir, accession }) => {
    try {
      const indexJson = JSON.parse(await politeFetchText(`${dir}index.json`, { headers: { "user-agent": ua } }));
      const xmlName = pickOwnershipXml(indexJson);
      if (!xmlName) return null;
      const xml = await politeFetchText(`${dir}${xmlName}`, { headers: { "user-agent": ua } });
      const filing = parseForm4Xml(xml, { accession });
      persistForm4Xml(xml, dir, accession, filing);
      return filing;
    } catch {
      return null;
    }
  });
  return parsed.filter((f): f is InsiderFiling => f !== null);
}

function allWatchlistSymbols(): string[] {
  const out = new Set<string>();
  for (const userId of listUsers()) {
    for (const item of listWatchlistSymbols(userId)) {
      if (item.symbol) out.add(normalizeSymbol(item.symbol));
    }
  }
  return [...out];
}

async function scrapeRecentForm4s(now: number): Promise<InsiderFiling[]> {
  const ua = secUserAgent();
  const cap = maxFilings();
  const feed = await politeFetchText(
    `${SEC_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=4&count=100&output=atom`,
    { headers: { "user-agent": ua, accept: "application/atom+xml" } }
  );
  const current = parseCurrentForm4Feed(feed).slice(0, cap);
  const out = await fetchForm4FromDirs(current, ua);

  if (!resolveSourceBool("WEB_SOURCE_INSIDER_WATCHLIST")) return out;
  const remaining = Math.max(0, cap - current.length);
  if (remaining === 0) return out;

  let tickerCik: Record<string, string> = {};
  try {
    tickerCik = await loadTickerCikMap(now);
  } catch {
    return out;
  }
  const watch = allWatchlistSymbols().filter((s) => tickerCik[s]).slice(0, 20);
  const seen = new Set(current.map((f) => f.accession));
  const extra: Array<{ dir: string; accession: string }> = [];
  for (const symbol of watch) {
    if (extra.length >= remaining) break;
    try {
      const cik = tickerCik[symbol];
      const atom = await politeFetchText(
        `${SEC_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&owner=include&count=8&output=atom`,
        { headers: { "user-agent": ua, accept: "application/atom+xml" } }
      );
      for (const hit of parseCurrentForm4Feed(atom)) {
        if (seen.has(hit.accession)) continue;
        seen.add(hit.accession);
        extra.push(hit);
        if (extra.length >= remaining) break;
      }
    } catch {
      // Skip one symbol; keep the rest of the watchlist pass.
    }
  }
  if (extra.length === 0) return out;
  const more = await fetchForm4FromDirs(extra.slice(0, remaining), ua);
  return [...out, ...more];
}

/** Merge fresh filings into the rolling window, deduped by accession, pruned to window. */
export function mergeInsiderFilings(existing: InsiderFiling[], fresh: InsiderFiling[], now: number, window = windowDays()): InsiderFiling[] {
  const cutoff = now - window * 24 * 60 * 60_000;
  const byAccession = new Map<string, InsiderFiling>();
  for (const f of [...existing, ...fresh]) {
    const ts = Date.parse(f.filedAt);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    byAccession.set(f.accession, f);
  }
  return Array.from(byAccession.values());
}

// ── External upsert (push webhook / SSE from App A congress.trade) ────────────
// App A may push raw Form-4 filings OR a precomputed per-symbol insiderSentiment (0–100). We accept
// both: raw filings merge straight into the rolling dataset; a scalar is represented as one synthetic
// "marker" filing whose buy/sell transaction counts reproduce that sentiment when aggregated.

/** Build a synthetic marker filing so a pushed insiderSentiment (0–100) flows through aggregation. */
export function insiderFilingFromSentiment(symbol: string, sentiment: number, asOf?: string): InsiderFiling | null {
  const sym = normalizeSymbol(symbol);
  const s = Math.max(0, Math.min(100, Math.round(sentiment)));
  if (!sym || !Number.isFinite(sentiment)) return null;
  const filedAt = asOf && /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(0, 10) : new Date().toISOString().slice(0, 10);
  // buyTx/sellTx sum to 100 so aggregateInsiderSignals reproduces `s` = buyTx/(buyTx+sellTx)*100.
  // Accession is stable per symbol+day → re-sends overwrite rather than accumulate.
  return {
    symbol: sym,
    owner: "congress.trade",
    buyTx: s,
    sellTx: 100 - s,
    buyShares: 0,
    sellShares: 0,
    filedAt,
    accession: `appA:insider:${sym}:${filedAt}`
  };
}

/** Tolerantly coerce a pushed raw Form-4 row into an InsiderFiling (requires symbol + accession). */
export function coerceInsiderFiling(raw: unknown): InsiderFiling | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const symbol = normalizeSymbol(typeof o.symbol === "string" ? o.symbol : typeof o.ticker === "string" ? o.ticker : "");
  const accession = typeof o.accession === "string" ? o.accession : typeof o.id === "string" ? o.id : "";
  if (!symbol || !accession) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const rawFiled = typeof o.filedAt === "string" ? o.filedAt : typeof o.date === "string" ? o.date : "";
  const saneFiled = saneFilingDate(rawFiled);
  // A supplied filing date that is future-dated or otherwise garbage is a data error → drop the row
  // rather than surface an impossible date. With no date at all, default to today.
  if (rawFiled && !saneFiled) return null;
  const filedAt = saneFiled ?? new Date().toISOString().slice(0, 10);
  return {
    symbol,
    // Never store an empty owner (the InsiderFiling contract wants a non-empty string); the
    // buy/sell counts carry the actual signal, so default a missing owner rather than dropping it.
    owner: (typeof o.owner === "string" && o.owner.trim()) || "unknown",
    buyTx: num(o.buyTx),
    sellTx: num(o.sellTx),
    buyShares: num(o.buyShares),
    sellShares: num(o.sellShares),
    filedAt,
    accession
  };
}

/** Merge externally-received insider filings into the persisted dataset. Returns the new total. */
export function upsertInsiderFilings(incoming: InsiderFiling[], now: number = Date.now()): { total: number } {
  const clean = incoming.filter((f): f is InsiderFiling => Boolean(f && f.symbol && f.accession));
  const prior = getInsiderDataset();
  if (clean.length === 0) return { total: prior?.recordCount ?? 0 };
  const merged = mergeInsiderFilings(prior?.filings ?? [], clean, now);
  const dataset: InsiderDataset = { filings: merged, fetchedAt: new Date(now).toISOString(), recordCount: merged.length };
  setInternalSetting(DATASET_KEY, dataset);
  return { total: merged.length };
}

export async function refreshInsider(now: number = Date.now(), force = false): Promise<WebSourceRefreshResult> {
  if (!force && !isInsiderRefreshDue(now)) {
    const ds = getInsiderDataset();
    return { id: "insider", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds ? ["sec-edgar"] : [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }

  // Record the attempt so a failure backs off instead of re-firing every tick.
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  let fresh: InsiderFiling[] = [];
  let warning: string | undefined;
  try {
    fresh = await scrapeRecentForm4s(now);
  } catch (error) {
    warning = error instanceof Error ? error.message : "sec-edgar failed";
  }

  const prior = getInsiderDataset();
  const merged = mergeInsiderFilings(prior?.filings ?? [], fresh, now);
  // Only advance fetchedAt when we actually fetched something; otherwise keep the
  // prior success time so the dashboard reflects true freshness and the TTL gate
  // (with the attempt backoff above) schedules the next retry correctly.
  const fetchedAt = fresh.length > 0 ? new Date(now).toISOString() : prior?.fetchedAt ?? new Date(now).toISOString();

  // Persist as long as we have *some* data (fresh or still-valid prior). Only bail
  // entirely when there's nothing at all, so a transient outage never wipes the window.
  if (merged.length === 0) {
    audit("web_source_refresh", { id: "insider", ok: false, recordCount: 0, warning });
    return { id: "insider", ok: false, recordCount: 0, sources: [], fetchedAt: prior?.fetchedAt ?? "", warning: warning ?? "no records" };
  }

  const dataset: InsiderDataset = { filings: merged, fetchedAt, recordCount: merged.length };
  setInternalSetting(DATASET_KEY, dataset);
  const ok = fresh.length > 0;
  audit("web_source_refresh", { id: "insider", ok, recordCount: merged.length, fresh: fresh.length, warning });
  return { id: "insider", ok, recordCount: merged.length, sources: ["sec-edgar"], fetchedAt, warning };
}
