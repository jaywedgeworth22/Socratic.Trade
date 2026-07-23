// db-securities-import.ts — local writable EOD cache for the congress.trade (App A) return-path.
//
// App B's own price history is the live `fetchDailyOHLC` cascade, not a writable store. This module
// IS the writable store that App A's gap-fill push (POST /api/admin/securities/import) lands in, so
// imported closes can warm a cache-aside tier in `fetchDailyOHLC` and displace a re-fetch. Three
// tables (declared in db.ts migrate()): imported_securities_ref, imported_price_eod, imported_spx_eod.
//
// Row-level shapes are defined locally (NOT imported from ./congress-share) to keep the db barrel
// free of a cycle: congress-share imports from ./db, and ./db re-exports this module.
import { getDb } from "./db";

// ── Row shapes (a structural subset of congress-share's payload types) ──────────

export interface ImportedRefInput {
  ticker: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  assetClass?: string;
  exchange?: string;
  currency?: string;
  marketCap?: number;
  cik?: string;
}

export interface ImportedCloseInput {
  date: string; // YYYY-MM-DD
  close: number;
  volume?: number;
}

export interface ImportedPriceInput {
  ticker: string;
  closes: ImportedCloseInput[];
}

/** A {date, close, volume?} row as read back out for the cache-aside history tier (ascending date). */
export interface ImportedClose {
  date: string;
  close: number;
  volume?: number;
}

export interface ImportPersistResult {
  refs: number;
  pricedTickers: number;
  priceRows: number;
  spxRows: number;
}

const DEFAULT_ORIGIN = "app-a";

function normTicker(raw: string): string {
  return (raw ?? "").trim().toUpperCase();
}

function normDisplayText(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  return value ? value : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** YYYY-MM-DD only — reject anything that isn't a plausible calendar date so junk never persists. */
function normDate(raw: string): string | null {
  const s = (raw ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ── Upserts (idempotent, keyed; non-destructive — missing fields keep prior value) ──

/** Upsert company refs. Returns the count of rows written. `origin` defaults to 'app-a'. */
export function upsertImportedRefs(refs: ImportedRefInput[], origin: string = DEFAULT_ORIGIN): number {
  if (!Array.isArray(refs) || refs.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = getDb().prepare(
    `INSERT INTO imported_securities_ref
       (ticker, company_name, sector, industry, asset_class, exchange, currency, market_cap, cik, origin, updated_at)
     VALUES (@ticker, @companyName, @sector, @industry, @assetClass, @exchange, @currency, @marketCap, @cik, @origin, @updatedAt)
     ON CONFLICT(ticker) DO UPDATE SET
       company_name = COALESCE(excluded.company_name, imported_securities_ref.company_name),
       sector       = COALESCE(excluded.sector, imported_securities_ref.sector),
       industry     = COALESCE(excluded.industry, imported_securities_ref.industry),
       asset_class  = COALESCE(excluded.asset_class, imported_securities_ref.asset_class),
       exchange     = COALESCE(excluded.exchange, imported_securities_ref.exchange),
       currency     = COALESCE(excluded.currency, imported_securities_ref.currency),
       market_cap   = COALESCE(excluded.market_cap, imported_securities_ref.market_cap),
       cik          = COALESCE(excluded.cik, imported_securities_ref.cik),
       origin       = excluded.origin,
       updated_at   = excluded.updated_at`
  );
  let count = 0;
  const run = getDb().transaction((rows: ImportedRefInput[]) => {
    for (const r of rows) {
      const ticker = normTicker(r.ticker);
      if (!ticker) continue;
      stmt.run({
        ticker,
        companyName: normDisplayText(r.companyName),
        sector: r.sector ?? null,
        industry: r.industry ?? null,
        assetClass: r.assetClass ?? null,
        exchange: r.exchange ?? null,
        currency: r.currency ?? null,
        marketCap: isFiniteNumber(r.marketCap) ? r.marketCap : null,
        cik: r.cik ?? null,
        origin,
        updatedAt: now
      });
      count++;
    }
  });
  run(refs);
  return count;
}

/** Upsert per-ticker daily closes. Returns {tickers, rows} actually written. */
export function upsertImportedPrices(prices: ImportedPriceInput[], origin: string = DEFAULT_ORIGIN): { tickers: number; rows: number } {
  if (!Array.isArray(prices) || prices.length === 0) return { tickers: 0, rows: 0 };
  const now = new Date().toISOString();
  const stmt = getDb().prepare(
    `INSERT INTO imported_price_eod (ticker, date, close, volume, origin, updated_at)
     VALUES (@ticker, @date, @close, @volume, @origin, @updatedAt)
     ON CONFLICT(ticker, date) DO UPDATE SET
       close      = excluded.close,
       volume     = COALESCE(excluded.volume, imported_price_eod.volume),
       origin     = excluded.origin,
       updated_at = excluded.updated_at`
  );
  let tickers = 0;
  let rows = 0;
  const run = getDb().transaction((entries: ImportedPriceInput[]) => {
    for (const p of entries) {
      const ticker = normTicker(p.ticker);
      if (!ticker || !Array.isArray(p.closes)) continue;
      let wroteForTicker = false;
      for (const c of p.closes) {
        const date = normDate(c.date);
        if (!date || !isFiniteNumber(c.close)) continue;
        stmt.run({ ticker, date, close: c.close, volume: isFiniteNumber(c.volume) ? c.volume : null, origin, updatedAt: now });
        rows++;
        wroteForTicker = true;
      }
      if (wroteForTicker) tickers++;
    }
  });
  run(prices);
  return { tickers, rows };
}

/** Upsert the S&P-500 (^GSPC) daily close series. Returns the count of rows written. */
export function upsertImportedSpx(closes: ImportedCloseInput[], origin: string = DEFAULT_ORIGIN): number {
  if (!Array.isArray(closes) || closes.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = getDb().prepare(
    `INSERT INTO imported_spx_eod (date, close, volume, origin, updated_at)
     VALUES (@date, @close, @volume, @origin, @updatedAt)
     ON CONFLICT(date) DO UPDATE SET
       close      = excluded.close,
       volume     = COALESCE(excluded.volume, imported_spx_eod.volume),
       origin     = excluded.origin,
       updated_at = excluded.updated_at`
  );
  let count = 0;
  const run = getDb().transaction((rows: ImportedCloseInput[]) => {
    for (const c of rows) {
      const date = normDate(c.date);
      if (!date || !isFiniteNumber(c.close)) continue;
      stmt.run({ date, close: c.close, volume: isFiniteNumber(c.volume) ? c.volume : null, origin, updatedAt: now });
      count++;
    }
  });
  run(closes);
  return count;
}

/**
 * Persist a whole import payload in one shot. `origin` tags every row's provenance. Rows whose
 * origin matches App B's own outbound id are the caller's responsibility to skip BEFORE calling this
 * (the route does that) — this is the low-level writer.
 */
export function persistSecuritiesImport(
  payload: { refs?: ImportedRefInput[]; prices?: ImportedPriceInput[]; spx?: ImportedCloseInput[] },
  origin: string = DEFAULT_ORIGIN
): ImportPersistResult {
  const refs = upsertImportedRefs(payload.refs ?? [], origin);
  const priced = upsertImportedPrices(payload.prices ?? [], origin);
  const spxRows = upsertImportedSpx(payload.spx ?? [], origin);
  return { refs, pricedTickers: priced.tickers, priceRows: priced.rows, spxRows };
}

// ── Reads (for the fetchDailyOHLC cache-aside tier) ─────────────────────────────

/** Imported daily closes for a ticker, ascending by date. Empty when nothing imported. */
export function getImportedPriceCloses(ticker: string): ImportedClose[] {
  const sym = normTicker(ticker);
  if (!sym) return [];
  const rows = getDb()
    .prepare("SELECT date, close, volume FROM imported_price_eod WHERE ticker = ? ORDER BY date ASC")
    .all(sym) as Array<{ date: string; close: number; volume: number | null }>;
  return rows.map((r) => (r.volume === null ? { date: r.date, close: r.close } : { date: r.date, close: r.close, volume: r.volume }));
}

/** Imported S&P-500 (^GSPC) daily closes, ascending by date. */
export function getImportedSpxCloses(): ImportedClose[] {
  const rows = getDb()
    .prepare("SELECT date, close, volume FROM imported_spx_eod ORDER BY date ASC")
    .all() as Array<{ date: string; close: number; volume: number | null }>;
  return rows.map((r) => (r.volume === null ? { date: r.date, close: r.close } : { date: r.date, close: r.close, volume: r.volume }));
}

/** One imported company ref (or undefined). */
export function getImportedRef(ticker: string): (ImportedRefInput & { origin: string; updatedAt: string }) | undefined {
  const sym = normTicker(ticker);
  if (!sym) return undefined;
  const row = getDb()
    .prepare(
      `SELECT ticker, company_name, sector, industry, asset_class, exchange, currency, market_cap, cik, origin, updated_at
       FROM imported_securities_ref WHERE ticker = ?`
    )
    .get(sym) as
    | {
        ticker: string;
        company_name: string | null;
        sector: string | null;
        industry: string | null;
        asset_class: string | null;
        exchange: string | null;
        currency: string | null;
        market_cap: number | null;
        cik: string | null;
        origin: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    ticker: row.ticker,
    companyName: row.company_name ?? undefined,
    sector: row.sector ?? undefined,
    industry: row.industry ?? undefined,
    assetClass: row.asset_class ?? undefined,
    exchange: row.exchange ?? undefined,
    currency: row.currency ?? undefined,
    marketCap: row.market_cap ?? undefined,
    cik: row.cik ?? undefined,
    origin: row.origin,
    updatedAt: row.updated_at
  };
}

export interface ImportedCacheCounts {
  refs: number;
  pricedTickers: number;
  priceRows: number;
  spxRows: number;
}

/** Row counts across the imported cache (for the admin route response + observability). */
export function getImportedCacheCounts(): ImportedCacheCounts {
  const db = getDb();
  const refs = (db.prepare("SELECT COUNT(*) AS n FROM imported_securities_ref").get() as { n: number }).n;
  const pricedTickers = (db.prepare("SELECT COUNT(DISTINCT ticker) AS n FROM imported_price_eod").get() as { n: number }).n;
  const priceRows = (db.prepare("SELECT COUNT(*) AS n FROM imported_price_eod").get() as { n: number }).n;
  const spxRows = (db.prepare("SELECT COUNT(*) AS n FROM imported_spx_eod").get() as { n: number }).n;
  return { refs, pricedTickers, priceRows, spxRows };
}

/** Test seam: wipe the imported cache. */
export function clearImportedSecuritiesForTests(): void {
  const db = getDb();
  db.prepare("DELETE FROM imported_price_eod").run();
  db.prepare("DELETE FROM imported_spx_eod").run();
  db.prepare("DELETE FROM imported_securities_ref").run();
}
