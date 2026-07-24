import { getDb } from "./db";
import type { Database } from "better-sqlite3";

export interface HistoricalFundamentalRecord {
  symbol: string;
  field: string;
  value: number;
  provider: string;
  effectiveAt: string;
  fetchedAt: string;
}

export function recordHistoricalFundamentals(records: HistoricalFundamentalRecord[], database: Database = getDb()): void {
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
