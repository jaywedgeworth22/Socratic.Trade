import fs from "fs";
import path from "path";
import { getDb } from "../../src/lib/db";
import { loadCikMap, loadTickerCikMap } from "../../src/lib/web-sources/sec8k";
import { SP500_SYMBOLS } from "../../src/lib/sp500";
import { NASDAQ100_SYMBOLS, DOW30_SYMBOLS } from "../../src/lib/index-universes";
import { normalizeSymbol } from "../../src/lib/money";

interface UniverseEntry {
  cik: string;
  ticker: string;
  title: string;
  inclusionReason: string;
  /** Alternative tickers for the same CIK (e.g. GOOG/GOOGL for Alphabet). */
  aliases?: string[];
}

async function fetchSecTickerList(): Promise<Array<{ cik: number; ticker: string; title: string }>> {
  // SEC company_tickers.json is fetched directly to preserve the original ordering (prominence order)
  // because loadCikMap converts it to a key-value record where order is lost.
  const { secUserAgent } = await import("../../src/lib/web-sources/http");
  const { politeFetchText } = await import("../../src/lib/web-sources/http");
  const url = "https://www.sec.gov/files/company_tickers.json";
  console.log(`  Fetching company tickers from SEC: ${url}`);
  const text = await politeFetchText(url, { headers: { "user-agent": secUserAgent() } });
  const data = JSON.parse(text) as Record<string, { cik_str: number; ticker: string; title: string }>;
  return Object.values(data).map(row => ({
    cik: row.cik_str,
    ticker: row.ticker,
    title: row.title
  }));
}

async function main() {
  console.log("\n▶ SEC/RAG 1,000-Stock Universe Manifest Generator");

  const now = Date.now();
  
  // 1. Load active/traded symbols from DB history
  const db = getDb();
  const fillSymbols = db.prepare("SELECT DISTINCT symbol FROM fill_events").all() as Array<{ symbol: string }>;
  const chunkSymbols = db.prepare("SELECT DISTINCT symbol FROM document_chunks").all() as Array<{ symbol: string }>;
  const watchlistSymbols = db.prepare("SELECT DISTINCT symbol FROM user_watchlist").all() as Array<{ symbol: string }>;
  const skippedSymbols = db.prepare("SELECT DISTINCT symbol FROM skipped_candidate_counterfactuals").all() as Array<{ symbol: string }>;
  
  const dbSymbols = new Set<string>();
  [fillSymbols, chunkSymbols, watchlistSymbols, skippedSymbols].forEach(list => {
    list.forEach(s => {
      const norm = normalizeSymbol(s.symbol);
      if (norm) dbSymbols.add(norm);
    });
  });
  console.log(`  Found ${dbSymbols.size} unique symbols from local database history (fills/chunks/watchlists/skipped).`);

  // 2. Load index symbols
  const indexSymbols = new Set<string>([
    ...SP500_SYMBOLS,
    ...NASDAQ100_SYMBOLS,
    ...DOW30_SYMBOLS
  ].map(normalizeSymbol).filter(Boolean) as string[]);
  console.log(`  Found ${indexSymbols.size} unique symbols in S&P 500, Nasdaq 100, and Dow 30.`);

  // 3. Fetch full SEC ticker CIK list
  let secList: Array<{ cik: number; ticker: string; title: string }> = [];
  try {
    secList = await fetchSecTickerList();
    console.log(`  Loaded ${secList.length} company tickers from the SEC.`);
  } catch (err) {
    console.error("  ❌ Failed to fetch SEC ticker list:", err);
    process.exit(1);
  }

  // Build direct mapping records
  const secTickerToCik: Record<string, string> = {};
  const secCikToTicker: Record<string, string> = {};
  const secCikToTitle: Record<string, string> = {};

  secList.forEach(row => {
    const normTicker = normalizeSymbol(row.ticker);
    const paddedCik = String(row.cik).padStart(10, "0");
    if (normTicker) {
      secTickerToCik[normTicker] = paddedCik;
      // Keep first matching CIK ticker mapping for reverse lookup, or update if prominent
      if (!secCikToTicker[paddedCik]) {
        secCikToTicker[paddedCik] = normTicker;
      }
      secCikToTitle[paddedCik] = row.title;
    }
  });

  const universe: UniverseEntry[] = [];
  const addedCiks = new Set<string>();
  const addedTickers = new Set<string>();

  const addIssuer = (cik: string, ticker: string, title: string, reason: string) => {
    if (addedCiks.has(cik)) {
      // CIK already exists — track alias ticker for multi-ticker entities (e.g. GOOG/GOOGL)
      if (!addedTickers.has(ticker)) {
        addedTickers.add(ticker);
        const existing = universe.find(e => e.cik === cik);
        if (existing) {
          existing.aliases = existing.aliases ?? [];
          if (!existing.aliases.includes(ticker)) {
            existing.aliases.push(ticker);
          }
        }
      }
      return false;
    }
    if (universe.length >= 1000) return false; // hard cap at 1,000 CIKs
    addedCiks.add(cik);
    addedTickers.add(ticker);
    universe.push({
      cik,
      ticker,
      title,
      inclusionReason: reason,
      aliases: [],
    });
    return true;
  };

  // Tranche 1: Traded database symbols
  console.log("  Processing Tranche 1: DB History...");
  let dbAdded = 0;
  for (const sym of dbSymbols) {
    const cik = secTickerToCik[sym];
    if (cik) {
      const title = secCikToTitle[cik] ?? "";
      // NOTE: we use "top-prominence" here rather than "held-history" so the
      // frozen manifest never leaks which symbols come from the owner's real
      // trade/watch history. The DB is the selection mechanism; the manifest
      // is a neutral reference file tracked in the public repo.
      if (addIssuer(cik, sym, title, "top-prominence")) {
        dbAdded++;
      }
    } else {
      console.log(`  ⚠️  Ticker ${sym} from DB history could not be mapped to an SEC CIK.`);
    }
  }
  console.log(`  Added ${dbAdded} issuers from DB history.`);

  // Tranche 2: Index symbols
  console.log("  Processing Tranche 2: Index Members...");
  let indexAdded = 0;
  for (const sym of indexSymbols) {
    const cik = secTickerToCik[sym];
    if (cik) {
      const title = secCikToTitle[cik] ?? "";
      if (addIssuer(cik, sym, title, "index-member")) {
        indexAdded++;
      }
    }
  }
  console.log(`  Added ${indexAdded} new issuers from index memberships.`);

  // Tranche 3: Top prominent SEC companies by original listing order
  console.log("  Processing Tranche 3: Filling up to 1,000 using top market-cap SEC listings...");
  let secAdded = 0;
  for (const row of secList) {
    if (universe.length >= 1000) break;
    const normTicker = normalizeSymbol(row.ticker);
    const paddedCik = String(row.cik).padStart(10, "0");
    if (normTicker) {
      if (addIssuer(paddedCik, normTicker, row.title, "top-prominence")) {
        secAdded++;
      }
    }
  }

  console.log(`  Added ${secAdded} new issuers from top SEC listings.`);
  console.log(`  Total universe size: ${universe.length} CIKs.`);

  if (universe.length < 1000) {
    console.warn(`  ⚠️  Warning: Managed to gather only ${universe.length} symbols. Universe is below 1,000.`);
  }

  // Sort by ticker before writing to avoid leaking DB-derived provenance through insertion order.
  universe.sort((a, b) => a.ticker.localeCompare(b.ticker));

  // 4. Save the manifest
  const destDir = path.dirname(path.resolve("data/rag-universe-manifest.json"));
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const manifestPath = path.resolve("data/rag-universe-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(universe, null, 2), "utf8");
  console.log(`  Manifest frozen successfully! Wrote to: ${manifestPath}`);
  console.log("══ Done ══════════════════════════════════════════════════\n");
}

main().catch(err => {
  console.error("Universe generator crashed:", err);
  process.exit(1);
});
