import { getDb } from "../../src/lib/db";
import { getVectorStoreStats } from "../../src/lib/vector-db";

interface DocTypeRow {
  doc_type: string;
  count: number;
  distinct_tickers: number;
  min_indexed_at: string;
  max_indexed_at: string;
}

interface SymbolCoverageRow {
  symbol: string;
  chunk_count: number;
  latest_at: string;
}

function median(sorted: string[]): string {
  if (sorted.length === 0) return "";
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? sorted[mid - 1]! : sorted[mid]!;
}

function reportByDocType(): DocTypeRow[] {
  return getDb()
    .prepare(
      `SELECT doc_type,
              COUNT(*) as count,
              COUNT(DISTINCT ticker) as distinct_tickers,
              MIN(indexed_at) as min_indexed_at,
              MAX(indexed_at) as max_indexed_at
       FROM ingested_accessions
       GROUP BY doc_type
       ORDER BY count DESC`
    )
    .all() as DocTypeRow[];
}

function medianIndexedAtByDocType(docType: string): string {
  const rows = getDb()
    .prepare("SELECT indexed_at FROM ingested_accessions WHERE doc_type = ? ORDER BY indexed_at ASC")
    .all(docType) as Array<{ indexed_at: string }>;
  return median(rows.map((r) => r.indexed_at));
}

function reportBySymbol(topN = 50): SymbolCoverageRow[] {
  return getDb()
    .prepare(
      `SELECT symbol,
              COUNT(*) as chunk_count,
              MAX(created_at) as latest_at
       FROM document_chunks
       GROUP BY symbol
       ORDER BY chunk_count DESC
       LIMIT ?`
    )
    .all(topN) as SymbolCoverageRow[];
}

function getConfigurationSummary() {
  return {
    RAG_INGEST_BUDGET_ENABLED: process.env.RAG_INGEST_BUDGET_ENABLED ?? "unset",
    RAG_INGEST_MAX_TEXTS_PER_DAY: process.env.RAG_INGEST_MAX_TEXTS_PER_DAY ?? "unset",
    RAG_PINECONE_WRITE_BUDGET_ENABLED: process.env.RAG_PINECONE_WRITE_BUDGET_ENABLED ?? "unset",
    RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY: process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY ?? "unset",
    VECTOR_STORECONTEXTS_DEDUP: process.env.VECTOR_STORECONTEXTS_DEDUP ?? "unset",
    SEC_FILING_RAG_MAX_PER_RUN: process.env.SEC_FILING_RAG_MAX_PER_RUN ?? "unset",
    SEC_FILING_INGEST_TTL_HOURS: process.env.SEC_FILING_INGEST_TTL_HOURS ?? "unset",
    WEB_SOURCE_SEC8K_RAG_LIMIT: process.env.WEB_SOURCE_SEC8K_RAG_LIMIT ?? "unset",
    WEB_SOURCE_SEC8K_FULL_BODY: process.env.WEB_SOURCE_SEC8K_FULL_BODY ?? "unset",
    RAG_EMBED_DISCLOSURES: process.env.RAG_EMBED_DISCLOSURES ?? "unset"
  };
}

async function performParityCheck() {
  const accessions = getDb()
    .prepare("SELECT accession, doc_type, ticker, chunk_count FROM ingested_accessions")
    .all() as Array<{ accession: string; doc_type: string; ticker: string; chunk_count: number }>;

  const chunks = getDb()
    .prepare("SELECT chunk_id, symbol, source FROM document_chunks")
    .all() as Array<{ chunk_id: string; symbol: string; source: string }>;

  console.log("── Parity & Integrity Analysis ──────────────────────────────");
  console.log(`  Total ingested accession markers: ${accessions.length}`);
  console.log(`  Total document chunk records: ${chunks.length}`);

  let missingChunks = 0;
  for (const acc of accessions) {
    // Check if there is any chunk that maps to this accession.
    // contextId format: source:symbol:accession:timestamp (or fallback with symbol:source:fallbackIndex)
    const hasChunk = chunks.some(c => c.chunk_id.includes(acc.accession));
    if (!hasChunk && acc.chunk_count > 0) {
      console.log(`  ⚠️  [Missing Chunks] Accession ${acc.accession} (${acc.doc_type}) for ${acc.ticker} has 0 local chunks recorded.`);
      missingChunks++;
    }
  }

  let orphans = 0;
  for (const chunk of chunks) {
    // Try to extract accession-like string from chunk_id (e.g. 0001193125-24-123456)
    const match = chunk.chunk_id.match(/(\d{10}-\d{2}-\d{6})/);
    if (match) {
      const accession = match[1]!;
      const hasAccession = accessions.some(a => a.accession === accession);
      if (!hasAccession) {
        console.log(`  ⚠️  [Orphan Chunk] Chunk "${chunk.chunk_id}" (${chunk.symbol}) has no matching ingested_accessions marker.`);
        orphans++;
      }
    }
  }

  console.log(`  Manifest-to-chunk parity: ${missingChunks} accessions missing chunks, ${orphans} orphan chunks.`);
}

async function main(): Promise<void> {
  console.log("\n▶ RAG Authenticated Corpus Census Report");
  console.log(`  Database: ${process.env.DATABASE_URL ?? "file:./data/app.db (default)"}\n`);

  console.log("── Active Runtime Configuration ──────────────────────────────");
  const config = getConfigurationSummary();
  for (const [k, v] of Object.entries(config)) {
    console.log(`  ${k.padEnd(40)} : ${v}`);
  }
  console.log("");

  const byDocType = reportByDocType();
  console.log("── SQLite Accession Metadata (ingested_accessions) ──────────");
  if (byDocType.length === 0) {
    console.log("  (no ingested_accessions rows — nothing has been ingested yet)");
  } else {
    console.log(
      `  ${"DOC_TYPE".padEnd(16)} ${"COUNT".padStart(7)} ${"TICKERS".padStart(8)}  ${"MIN_INDEXED".padEnd(20)} ${"MEDIAN_INDEXED".padEnd(20)} ${"MAX_INDEXED".padEnd(20)}`
    );
    for (const row of byDocType) {
      const med = medianIndexedAtByDocType(row.doc_type);
      console.log(
        `  ${row.doc_type.padEnd(16)} ${String(row.count).padStart(7)} ${String(row.distinct_tickers).padStart(8)}  ${row.min_indexed_at.padEnd(20)} ${med.padEnd(20)} ${row.max_indexed_at.padEnd(20)}`
      );
    }
  }
  console.log("");

  const bySymbol = reportBySymbol(50);
  console.log("── SQLite Chunk Records by Symbol (document_chunks, top 50) ──");
  if (bySymbol.length === 0) {
    console.log("  (no document_chunks rows — no chunks embedded yet)");
  } else {
    console.log(`  ${"SYMBOL".padEnd(10)} ${"CHUNKS".padStart(8)}  ${"LATEST_INDEXED".padEnd(24)}`);
    for (const row of bySymbol) {
      console.log(`  ${row.symbol.padEnd(10)} ${String(row.chunk_count).padStart(8)}  ${row.latest_at.padEnd(24)}`);
    }
  }
  console.log("");

  await performParityCheck();

  try {
    const stats = await getVectorStoreStats("local");
    console.log("\n── Live Pinecone Vector Store Stats ─────────────────────────");
    console.log(`  Index Name  : ${stats.indexName}`);
    console.log(`  Configured  : ${stats.configured}`);
    console.log(`  Exists      : ${stats.exists ?? "unknown"}`);
    if (stats.totalVectorCount != null) console.log(`  Total Vectors: ${stats.totalVectorCount}`);
    if (stats.dimension != null) console.log(`  Dimension    : ${stats.dimension}`);
    if (stats.error) console.log(`  Error       : ${stats.error}`);
  } catch (err) {
    console.log(`\n(Could not retrieve Pinecone stats: ${err instanceof Error ? err.message : String(err)})`);
  }

  console.log("\n══ Done ══════════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("Census script crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
