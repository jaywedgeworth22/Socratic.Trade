import { getDb } from "../src/lib/db.js";
import { normalizeSymbol } from "../src/lib/money.js";
import { refreshFilingBodies } from "../src/lib/web-sources/sec-filings.js";
import { activeEmbeddingModel, getVectorStoreStats } from "../src/lib/vector-db.js";
import { migrateLocalEnvCredentials } from "../src/lib/db-api-keys.js";
import readline from "readline";

// Parse CLI arguments
const args = process.argv.slice(2);
const isClearOnly = args.includes("--clear-only");
const isIngest = args.includes("--ingest");
const force = args.includes("--force");
const autoYes = args.includes("--yes") || args.includes("-y");

// Extract --ticker and --limit if present
let targetTicker: string | undefined;
const tickerIdx = args.indexOf("--ticker");
if (tickerIdx !== -1 && args[tickerIdx + 1]) {
  targetTicker = normalizeSymbol(args[tickerIdx + 1]!);
}

let limit: number | undefined;
const limitIdx = args.indexOf("--limit");
if (limitIdx !== -1 && args[limitIdx + 1]) {
  const parsed = parseInt(args[limitIdx + 1]!, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    limit = parsed;
  }
}

async function askConfirm(question: string): Promise<boolean> {
  if (autoYes) return true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

async function run() {
  console.log("▶ Reindexing SEC filings pipeline starting...");

  // 1. Migrate any credentials in env variables to local database
  console.log("  Migrating environment credentials...");
  const migration = migrateLocalEnvCredentials();
  if (migration.migrated.length > 0) {
    console.log(`  Migrated API credentials for: ${migration.migrated.join(", ")}`);
  }

  // 2. Validate active model
  const activeModel = activeEmbeddingModel("local");
  console.log(`  Active embedding model: ${activeModel}`);
  const isBgeM3 = activeModel.toLowerCase() === "baai/bge-m3";

  if (!isBgeM3 && !force) {
    console.error(`❌ Error: Active embedding model is ${activeModel}, NOT BAAI BGE-M3.`);
    console.error("   To proceed anyway, run the script with --force.");
    process.exit(1);
  }

  const db = getDb();

  // 3. Resolve symbols to reindex
  let tickers: string[] = [];
  if (targetTicker) {
    tickers = [targetTicker];
  } else {
    const tickersSet = new Set<string>();
    try {
      const filingsRows = db.prepare("SELECT DISTINCT ticker FROM sec_filings").all() as { ticker: string }[];
      for (const r of filingsRows) if (r.ticker) tickersSet.add(r.ticker);
      
      const hasIngested = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ingested_accessions'").get();
      if (hasIngested) {
        const legacyRows = db.prepare("SELECT DISTINCT ticker FROM ingested_accessions").all() as { ticker: string }[];
        for (const r of legacyRows) if (r.ticker) tickersSet.add(r.ticker);
      }
    } catch (err) {
      console.warn("  Failed to query existing tickers:", err instanceof Error ? err.message : String(err));
    }
    tickers = Array.from(tickersSet).map(s => normalizeSymbol(s));
  }

  if (tickers.length === 0) {
    console.log("  No tickers found to reindex. Exiting.");
    process.exit(0);
  }

  console.log(`  Targeting ${tickers.length} symbols: ${tickers.slice(0, 10).join(", ")}${tickers.length > 10 ? "..." : ""}`);

  // 4. Resolve accessions to clear
  const accessionsToClear = new Set<string>();
  for (const ticker of tickers) {
    const legacyRows = db.prepare(`
      SELECT accession FROM ingested_accessions WHERE ticker = ? AND doc_type IN ('10-K', '10-Q')
    `).all(ticker) as { accession: string }[];
    for (const r of legacyRows) accessionsToClear.add(r.accession);

    const filingRows = db.prepare(`
      SELECT accession FROM sec_filings WHERE ticker = ? AND form IN ('10-K', '10-Q')
    `).all(ticker) as { accession: string }[];
    for (const r of filingRows) accessionsToClear.add(r.accession);
  }

  if (accessionsToClear.size === 0) {
    console.log("  No completed cached filings found for target symbols.");
  } else {
    console.log(`  Found ${accessionsToClear.size} cached accession(s) to clear.`);
  }

  if (!isClearOnly && !isIngest) {
    console.log("  Please specify either --clear-only or --ingest.");
    process.exit(0);
  }

  // Ask for confirmation
  const actionText = isClearOnly ? "CLEAR RAG caches" : "CLEAR RAG caches AND re-embed filings";
  const confirmed = await askConfirm(`⚠️  Are you sure you want to ${actionText} for ${tickers.length} symbol(s)? Type YES to confirm: `);
  if (!confirmed) {
    console.log("❌ Cancelled by operator.");
    process.exit(0);
  }

  // 5. Clear caches
  if (accessionsToClear.size > 0) {
    console.log(`  Clearing local cache for ${accessionsToClear.size} accession(s)...`);
    const acns = Array.from(accessionsToClear);
    const BATCH_SIZE = 50;

    for (let i = 0; i < acns.length; i += BATCH_SIZE) {
      const batch = acns.slice(i, i + BATCH_SIZE);
      const ph = batch.map(() => "?").join(",");

      // 1. Delete from ingested_accessions
      db.prepare(`DELETE FROM ingested_accessions WHERE accession IN (${ph})`).run(...batch);

      // 2. Delete from document_chunks using chunk_id prefix check
      const chunkQueries = batch.map(() => "chunk_id LIKE '%:' || ? || ':%'").join(" OR ");
      db.prepare(`
        DELETE FROM document_chunks WHERE content_hash IN (
          SELECT content_hash FROM document_chunks WHERE (${chunkQueries}) AND source = 'sec-edgar'
        )
      `).run(...batch);

      // 3. Delete from chunk_occurrences
      db.prepare(`DELETE FROM chunk_occurrences WHERE accession IN (${ph})`).run(...batch);

      // 4. Update status in sec_filings
      const nowStr = new Date().toISOString();
      db.prepare(`
        UPDATE sec_filings SET status = 'discovered', updated_at = ? WHERE accession IN (${ph})
      `).run(nowStr, ...batch);
    }
    console.log("  ✅ Local cache cleared successfully.");
  }

  if (isClearOnly) {
    console.log("  ✅ --clear-only complete. Scheduler will pick up discovered filings incrementally.");
    process.exit(0);
  }

  // 6. Immediate ingestion
  console.log(`  Starting immediate ingestion for ${tickers.length} ticker(s)...`);
  const result = await refreshFilingBodies(tickers, Date.now(), limit, { force: true });
  
  if (result.errors.length > 0) {
    console.error("❌ Finished with errors:");
    for (const err of result.errors) console.error(`  - ${err}`);
  } else {
    console.log("  ✅ Ingestion complete successfully.");
  }
  
  console.log("  Ingestion stats:", {
    attempted: result.attempted,
    ingested: result.ingested,
    skipped: result.skipped,
    deferredForBudget: result.deferredForBudget
  });

  const stats = await getVectorStoreStats();
  console.log("  Vector Store Stats:", stats);
}

run().catch((err) => {
  console.error("❌ Fatal error during reindexing:", err);
  process.exit(1);
});
