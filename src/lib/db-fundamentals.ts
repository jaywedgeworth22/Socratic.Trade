/**
 * Durable market-field store.
 *
 * Two layers:
 * 1. `historical_fundamentals` — append-only numeric PIT history (existing).
 * 2. `symbol_field_latest` — latest known value for EVERY field on EVERY symbol
 *    ever seen, each row carrying its own `as_of` and `fetched_at` timestamps.
 *
 * The latest store is SHARED (no user_id): public market data (PE, sector,
 * volume, headlines, …) is not account-private. Symbols that leave the
 * universe or a given day's scan keep their last known fields forever until a
 * newer observation overwrites them field-by-field.
 *
 * Strategy-run audits deliberately strip the full MarketScan for size; this
 * table is the durable recovery path so interactive scans, other users, and
 * later strategy runs can still read the most recent per-field data.
 */

import { getDb } from "./db";
import type { Database } from "better-sqlite3";
import { normalizeSymbol } from "./money";

export interface HistoricalFundamentalRecord {
  symbol: string;
  field: string;
  value: number;
  provider: string;
  effectiveAt: string;
  fetchedAt: string;
}

/** One field's latest observation — timestamps are ALWAYS per-field, never scan-level. */
export interface SymbolFieldLatestRecord {
  symbol: string;
  field: string;
  /** JSON-encoded value (number | string | boolean | array | object). */
  valueJson: string;
  source: string;
  /** When the market fact was true / observed upstream (ISO). May equal fetchedAt. */
  asOf: string;
  /** When WE stored/received this value (ISO). */
  fetchedAt: string;
}

export function recordHistoricalFundamentals(
  records: HistoricalFundamentalRecord[],
  database: Database = getDb()
): void {
  if (records.length === 0) return;

  const stmt = database.prepare(`
    INSERT OR IGNORE INTO historical_fundamentals (symbol, field, value, provider, effective_at, fetched_at)
    VALUES (@symbol, @field, @value, @provider, @effectiveAt, @fetchedAt)
  `);

  const insertMany = database.transaction((recs: HistoricalFundamentalRecord[]) => {
    for (const rec of recs) {
      stmt.run(rec);
    }
  });

  insertMany(records);
}

/**
 * Upsert latest field values. Only overwrites an existing row when the incoming
 * `fetched_at` is >= the stored one (never clobber a newer observation with an
 * older write). Empty/invalid records are skipped.
 */
export function upsertSymbolFieldLatest(
  records: SymbolFieldLatestRecord[],
  database: Database = getDb()
): number {
  if (records.length === 0) return 0;

  const stmt = database.prepare(`
    INSERT INTO symbol_field_latest (symbol, field, value_json, source, as_of, fetched_at)
    VALUES (@symbol, @field, @valueJson, @source, @asOf, @fetchedAt)
    ON CONFLICT(symbol, field) DO UPDATE SET
      value_json = excluded.value_json,
      source = excluded.source,
      as_of = excluded.as_of,
      fetched_at = excluded.fetched_at
    WHERE excluded.fetched_at >= symbol_field_latest.fetched_at
  `);

  let written = 0;
  const run = database.transaction((recs: SymbolFieldLatestRecord[]) => {
    for (const rec of recs) {
      const symbol = normalizeSymbol(rec.symbol);
      const field = String(rec.field ?? "").trim();
      if (!symbol || !field || !rec.valueJson) continue;
      const asOf = rec.asOf || rec.fetchedAt;
      const fetchedAt = rec.fetchedAt || asOf;
      if (!fetchedAt) continue;
      const result = stmt.run({
        symbol,
        field,
        valueJson: rec.valueJson,
        source: rec.source || "unknown",
        asOf,
        fetchedAt
      });
      written += result.changes;
    }
  });
  run(records);
  return written;
}

export interface SymbolFieldLatestRow {
  symbol: string;
  field: string;
  value: unknown;
  source: string;
  /** Per-field observation / market-truth time. */
  asOf: string;
  /** Per-field when we stored it. */
  fetchedAt: string;
}

/** Load every latest field row for the given symbols (any subset; missing = no rows). */
export function getSymbolFieldLatest(
  symbols: string[],
  database: Database = getDb()
): SymbolFieldLatestRow[] {
  const normalized = Array.from(
    new Set(symbols.map((s) => normalizeSymbol(s)).filter(Boolean))
  );
  if (normalized.length === 0) return [];

  const placeholders = normalized.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT symbol, field, value_json, source, as_of, fetched_at
       FROM symbol_field_latest
       WHERE symbol IN (${placeholders})`
    )
    .all(...normalized) as Array<{
    symbol: string;
    field: string;
    value_json: string;
    source: string;
    as_of: string;
    fetched_at: string;
  }>;

  const out: SymbolFieldLatestRow[] = [];
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    out.push({
      symbol: row.symbol,
      field: row.field,
      value,
      source: row.source,
      asOf: row.as_of,
      fetchedAt: row.fetched_at
    });
  }
  return out;
}

/** Latest durable price per symbol (field = "price" only — cheaper than loading
 *  every field via getSymbolFieldLatest). Used by the dashboard snapshot as the
 *  Orders screen's final "Last price" fallback; each entry keeps its own as_of
 *  so the UI can age-tag it. Non-finite / non-positive stored values are
 *  skipped — never surface a fabricated price. */
export function getSymbolLatestPrices(
  symbols: string[],
  database: Database = getDb()
): Record<string, { price: number; asOf: string; source: string }> {
  const normalized = Array.from(new Set(symbols.map((s) => normalizeSymbol(s)).filter(Boolean)));
  if (normalized.length === 0) return {};

  const placeholders = normalized.map(() => "?").join(",");
  const rows = database
    .prepare(
      `SELECT symbol, value_json, source, as_of
       FROM symbol_field_latest
       WHERE field = 'price' AND symbol IN (${placeholders})`
    )
    .all(...normalized) as Array<{ symbol: string; value_json: string; source: string; as_of: string }>;

  const out: Record<string, { price: number; asOf: string; source: string }> = {};
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    out[row.symbol] = { price: value, asOf: row.as_of, source: row.source };
  }
  return out;
}

/** Group latest rows by symbol → field → row (handy for seed builders). */
export function getSymbolFieldLatestBySymbol(
  symbols: string[],
  database: Database = getDb()
): Record<string, Record<string, SymbolFieldLatestRow>> {
  const grouped: Record<string, Record<string, SymbolFieldLatestRow>> = {};
  for (const row of getSymbolFieldLatest(symbols, database)) {
    const byField = grouped[row.symbol] ?? (grouped[row.symbol] = {});
    byField[row.field] = row;
  }
  return grouped;
}

/** Encode a JS value for value_json; returns null when the value should not be stored. */
export function encodeFieldValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (Array.isArray(value) && value.length === 0) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Build latest-store records from a cascade-style enrichment map.
 * Prefer each field's FieldObservation timestamps when present; fall back to
 * `fallbackFetchedAt` so every stored field still carries per-field stamps.
 */
export function recordsFromEnrichmentMap(
  // Accept cascade SymbolEnrichment maps without forcing an index signature.
  merged: Record<string, object>,
  fallbackFetchedAt: string = new Date().toISOString()
): SymbolFieldLatestRecord[] {
  const META = new Set([
    "sources",
    "fieldObservations",
    "providerFailures",
    "fieldDates",
    "analystBySource",
    "shortPercentOfFloatSecondary",
    "shortInterestDisagreement"
  ]);
  const out: SymbolFieldLatestRecord[] = [];

  for (const [rawSymbol, enrichmentObj] of Object.entries(merged)) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol || !enrichmentObj) continue;
    const enrichment = enrichmentObj as Record<string, unknown>;

    const observations =
      (enrichment.fieldObservations as
        | Record<
            string,
            {
              value?: unknown;
              source?: string;
              asOf?: string;
              observedAt?: string;
              effectiveAt?: string;
              fetchedAt?: string;
            }
          >
        | undefined) ?? {};
    const sources = (enrichment.sources as Record<string, string> | undefined) ?? {};

    // Prefer explicit fieldObservations (they already carry per-field stamps).
    for (const [field, obs] of Object.entries(observations)) {
      if (!obs) continue;
      const value = obs.value !== undefined ? obs.value : enrichment[field];
      const valueJson = encodeFieldValue(value);
      if (!valueJson) continue;
      const asOf =
        obs.asOf ?? obs.observedAt ?? obs.effectiveAt ?? obs.fetchedAt ?? fallbackFetchedAt;
      const fetchedAt = obs.fetchedAt ?? fallbackFetchedAt;
      out.push({
        symbol,
        field,
        valueJson,
        source: obs.source ?? sources[field] ?? "unknown",
        asOf,
        fetchedAt
      });
    }

    // Also persist scalar/array keys that have values but no observation receipt
    // (e.g. headlines, analystRating after blend, provider-only fields).
    for (const [field, value] of Object.entries(enrichment)) {
      if (META.has(field)) continue;
      if (observations[field]) continue; // already handled
      const valueJson = encodeFieldValue(value);
      if (!valueJson) continue;
      const fieldDate = (enrichment.fieldDates as Record<string, string> | undefined)?.[field];
      out.push({
        symbol,
        field,
        valueJson,
        source: sources[field] ?? "unknown",
        asOf: fieldDate ?? fallbackFetchedAt,
        fetchedAt: fallbackFetchedAt
      });
    }
  }
  return out;
}

/**
 * Build seed-shaped quote summaries from the latest store for interactive/strategy
 * reuse. Each field keeps its own asOf/fetchedAt inside fieldObservations so the
 * UI can show per-cell age, not a single scan clock.
 */
export function marketQuoteSummariesFromFieldStore(
  symbols: string[],
  database: Database = getDb()
): Record<
  string,
  {
    symbol: string;
    price: number;
    score: number;
    sources?: Record<string, string>;
    fieldObservations?: Record<
      string,
      { value?: unknown; source: string; asOf?: string; fetchedAt?: string; status: "ok" }
    >;
    [key: string]: unknown;
  }
> {
  const bySymbol = getSymbolFieldLatestBySymbol(symbols, database);
  const out: ReturnType<typeof marketQuoteSummariesFromFieldStore> = {};

  for (const [symbol, fields] of Object.entries(bySymbol)) {
    const sources: Record<string, string> = {};
    const fieldObservations: NonNullable<
      (typeof out)[string]["fieldObservations"]
    > = {};
    const quote: (typeof out)[string] = {
      symbol,
      price: 0,
      score: 0,
      sources,
      fieldObservations
    };

    for (const [field, row] of Object.entries(fields)) {
      (quote as Record<string, unknown>)[field] = row.value;
      if (row.source) sources[field] = row.source;
      fieldObservations[field] = {
        value: row.value,
        source: row.source,
        asOf: row.asOf,
        fetchedAt: row.fetchedAt,
        status: "ok"
      };
    }

    // Seed validation in marketScanQuotesFromAudit requires finite price + score.
    // Use stored price when present; otherwise a sentinel 0 that applyEnrichment will
    // ignore for price-family (needs > 0) while still carrying slow fields.
    if (typeof quote.price !== "number" || !Number.isFinite(quote.price)) {
      quote.price = 0;
    }
    if (typeof quote.score !== "number" || !Number.isFinite(quote.score)) {
      quote.score = 0;
    }
    out[symbol] = quote;
  }
  return out;
}
