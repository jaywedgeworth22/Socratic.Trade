// SEC EDGAR 8-K (material event) ingestion.
//
// An 8-K is filed when something material happens (results, exec changes, major
// agreements, etc.), so a fresh 8-K is a catalyst flag worth surfacing to the agent.
// Free, no key (UA only). We read the market-wide "current 8-K" atom feed, map each
// filer's CIK to a ticker via SEC's company_tickers.json (cached weekly), and keep a
// short rolling window of "TICKER filed an 8-K" events. Coarse by design (no per-item
// parsing yet — that needs a fetch per filing); item-level detail is a follow-up.
// Never fabricated: no feed / no CIK match -> no event.

import { audit, getInternalSetting, setInternalSetting } from "../db";
import { normalizeSymbol } from "../money";
import { retryBackoffMs } from "./congress";
import { politeFetchText, secUserAgent } from "./http";

const DATASET_KEY = "webSource:sec8k:dataset";
const ATTEMPT_KEY = "webSource:sec8k:lastAttempt";
const CIK_KEY = "webSource:sec:cikMap";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily
const CIK_TTL_MS = 7 * 24 * 60 * 60_000; // ticker↔CIK map changes slowly
const DEFAULT_WINDOW_DAYS = 4; // an 8-K is only a "fresh" catalyst for a few days
const SEC_BASE = "https://www.sec.gov";

export interface EightKEvent {
  symbol: string;
  filedAt: string; // ISO date
  accession: string;
}
export interface EightKDataset {
  events: EightKEvent[];
  fetchedAt: string;
  recordCount: number;
}

export function eightKTtlMs(): number {
  const v = Number(process.env.WEB_SOURCE_SEC8K_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}
function windowDays(): number {
  const v = Number(process.env.WEB_SOURCE_SEC8K_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_DAYS;
}
export function getEightKDataset(): EightKDataset | undefined {
  return getInternalSetting<EightKDataset>(DATASET_KEY);
}

// ── Pure parsers (unit-tested) ───────────────────────────────────────────────

/** Parse the current-8-K atom feed into {cik, accession, filedAt} rows. */
export function parseCurrent8KFeed(atomXml: string): Array<{ cik: string; accession: string; filedAt?: string }> {
  const out: Array<{ cik: string; accession: string; filedAt?: string }> = [];
  const seen = new Set<string>();
  for (const entry of atomXml.split(/<entry>/i).slice(1)) {
    const title = entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const cik = title.match(/\((\d{4,10})\)/)?.[1];
    const link = entry.match(/href="([^"]+)"/i)?.[1] ?? "";
    const accession = link.match(/(\d{10}-\d{2}-\d{6})/)?.[1];
    const updated = entry.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1];
    if (!cik || !accession || seen.has(accession)) continue;
    seen.add(accession);
    out.push({ cik: String(Number(cik)), accession, filedAt: updated ? updated.slice(0, 10) : undefined });
  }
  return out;
}

/** Parse SEC company_tickers.json into a numeric-CIK-string -> ticker map. */
export function parseCikTickerMap(json: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const rows = json && typeof json === "object" ? Object.values(json as Record<string, unknown>) : [];
  for (const row of rows) {
    const r = row as { cik_str?: number | string; ticker?: string };
    if (r?.cik_str == null || !r.ticker) continue;
    map[String(Number(r.cik_str))] = normalizeSymbol(r.ticker);
  }
  return map;
}

// ── Read API ─────────────────────────────────────────────────────────────────

export interface EightKSignal {
  count: number;
  lastFiledAt?: string;
  bulletin: string;
}

export function getEightKSignals(symbols: string[], now: number = Date.now()): Record<string, EightKSignal> {
  const dataset = getEightKDataset();
  if (!dataset?.events?.length) return {};
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const cutoff = now - windowDays() * 24 * 60 * 60_000;
  const bySymbol = new Map<string, EightKEvent[]>();
  for (const e of dataset.events) {
    if (!wanted.has(e.symbol)) continue;
    const ts = Date.parse(e.filedAt);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    (bySymbol.get(e.symbol) ?? bySymbol.set(e.symbol, []).get(e.symbol)!).push(e);
  }
  const out: Record<string, EightKSignal> = {};
  for (const [symbol, events] of bySymbol) {
    events.sort((a, b) => Date.parse(b.filedAt) - Date.parse(a.filedAt));
    const last = events[0]?.filedAt;
    out[symbol] = {
      count: events.length,
      lastFiledAt: last,
      bulletin: `Catalyst: ${symbol} filed ${events.length > 1 ? `${events.length} 8-Ks` : "an 8-K"} (material event) ${last ? `on ${last}` : "recently"} — check for fresh news.`
    };
  }
  return out;
}

// ── Refresh ──────────────────────────────────────────────────────────────────

export function isEightKRefreshDue(now: number = Date.now()): boolean {
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  if (lastAttempt && now - Date.parse(lastAttempt) < retryBackoffMs()) return false;
  const ds = getEightKDataset();
  if (!ds?.fetchedAt) return true;
  return now - Date.parse(ds.fetchedAt) >= eightKTtlMs();
}

/** Load the CIK→ticker map, cached weekly in the settings KV. */
async function loadCikMap(now: number): Promise<Record<string, string>> {
  const cached = getInternalSetting<{ map: Record<string, string>; fetchedAt: string }>(CIK_KEY);
  if (cached?.map && cached.fetchedAt && now - Date.parse(cached.fetchedAt) < CIK_TTL_MS) return cached.map;
  const json = JSON.parse(await politeFetchText(`${SEC_BASE}/files/company_tickers.json`, { headers: { "user-agent": secUserAgent() } }));
  const map = parseCikTickerMap(json);
  if (Object.keys(map).length > 0) setInternalSetting(CIK_KEY, { map, fetchedAt: new Date(now).toISOString() });
  return map;
}

export function mergeEightK(existing: EightKEvent[], fresh: EightKEvent[], now: number, window = windowDays()): EightKEvent[] {
  const cutoff = now - window * 24 * 60 * 60_000;
  const byAccession = new Map<string, EightKEvent>();
  for (const e of [...existing, ...fresh]) {
    const ts = Date.parse(e.filedAt);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    byAccession.set(e.accession, e);
  }
  return Array.from(byAccession.values());
}

export async function refreshEightK(now: number = Date.now(), force = false): Promise<import("./types").WebSourceRefreshResult> {
  if (!force && !isEightKRefreshDue(now)) {
    const ds = getEightKDataset();
    return { id: "sec8k", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds ? ["sec-edgar"] : [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  let fresh: EightKEvent[] = [];
  let warning: string | undefined;
  try {
    const cikMap = await loadCikMap(now);
    const feed = await politeFetchText(
      `${SEC_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=100&output=atom`,
      { headers: { "user-agent": secUserAgent(), accept: "application/atom+xml" } }
    );
    fresh = parseCurrent8KFeed(feed)
      .map((row) => ({ symbol: cikMap[row.cik], filedAt: row.filedAt ?? new Date(now).toISOString().slice(0, 10), accession: row.accession }))
      .filter((e): e is EightKEvent => Boolean(e.symbol));
  } catch (error) {
    warning = error instanceof Error ? error.message : "sec8k failed";
  }

  const prior = getEightKDataset();
  const merged = mergeEightK(prior?.events ?? [], fresh, now);
  if (merged.length === 0) {
    audit("web_source_refresh", { id: "sec8k", ok: false, recordCount: 0, warning });
    return { id: "sec8k", ok: false, recordCount: 0, sources: [], fetchedAt: prior?.fetchedAt ?? "", warning: warning ?? "no events" };
  }
  const fetchedAt = fresh.length > 0 ? new Date(now).toISOString() : (prior?.fetchedAt ?? new Date(now).toISOString());
  const dataset: EightKDataset = { events: merged, fetchedAt, recordCount: merged.length };
  setInternalSetting(DATASET_KEY, dataset);
  const ok = fresh.length > 0;
  audit("web_source_refresh", { id: "sec8k", ok, recordCount: merged.length, fresh: fresh.length, warning });

  // Store new filings into vector DB for RAG
  if (fresh.length > 0) {
    import("../vector-db").then(({ storeContext }) => {
      for (const e of fresh) {
        storeContext(
          `SEC 8-K Filing for ${e.symbol} on ${e.filedAt}. Accession: ${e.accession}.`,
          { symbol: e.symbol, source: "sec-8k", timestamp: e.filedAt }
        ).catch(console.error);
      }
    }).catch(console.error);
  }

  return { id: "sec8k", ok, recordCount: merged.length, sources: ["sec-edgar"], fetchedAt, warning };
}
