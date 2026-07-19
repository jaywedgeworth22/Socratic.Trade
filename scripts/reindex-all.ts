import { getDb } from "../src/lib/db.js";
import { normalizeSymbol } from "../src/lib/money.js";
import { activeEmbeddingModel, getVectorStoreStats } from "../src/lib/vector-db.js";
import { migrateLocalEnvCredentials } from "../src/lib/db-api-keys.js";
import { 
  startCorpusReembedRun, 
  runCorpusReembedDryRun,
  purgeLegacyEmbeddingSpace,
  getCorpusReembedProgress,
  CORPUS_REEMBED_DOC_TYPES,
  type CorpusReembedDocType
} from "../src/lib/rag/corpus-reembed.js";
import readline from "readline";

// Parse CLI arguments
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const isPurgeLegacy = args.includes("--purge-legacy");
const force = args.includes("--force");
const autoYes = args.includes("--yes") || args.includes("-y");

// Extract --ticker
let targetTicker: string | undefined;
const tickerIdx = args.indexOf("--ticker");
if (tickerIdx !== -1 && args[tickerIdx + 1]) {
  targetTicker = normalizeSymbol(args[tickerIdx + 1]!);
}

// Extract --max-texts
let maxTexts: number | undefined;
const maxTextsIdx = args.indexOf("--max-texts");
if (maxTextsIdx !== -1 && args[maxTextsIdx + 1]) {
  const parsed = parseInt(args[maxTextsIdx + 1]!, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    maxTexts = parsed;
  }
}

// Extract --doc-types (comma separated)
let docTypes: CorpusReembedDocType[] | undefined;
const docTypesIdx = args.indexOf("--doc-types");
if (docTypesIdx !== -1 && args[docTypesIdx + 1]) {
  const parsed = args[docTypesIdx + 1]!.split(",").map(s => s.trim());
  const valid = parsed.filter(s => CORPUS_REEMBED_DOC_TYPES.includes(s as CorpusReembedDocType)) as CorpusReembedDocType[];
  if (valid.length > 0) {
    docTypes = valid;
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

function printProgress() {
  const progress = getCorpusReembedProgress();
  console.log(`\n📊 Corpus Re-embed Progress:`);
  console.log(`  Active Model: ${progress.activeEmbedModel}`);
  console.log(`  Active Space Revision: ${progress.activeEmbedRevision}`);
  if (progress.persisted) {
    console.log(`  Status: ${progress.persisted.status}`);
    console.log(`  Last Run: ${progress.persisted.updatedAt}`);
    if (progress.persisted.error) {
      console.log(`  Error: ${progress.persisted.error}`);
    }
    console.log(`  DocTypes:`);
    for (const [docType, dtProgress] of Object.entries(progress.persisted.docTypes)) {
      if (!dtProgress) continue;
      console.log(`    - ${docType} (${dtProgress.status}):`);
      console.log(`      Candidates Seen: ${dtProgress.candidatesSeen}`);
      console.log(`      Embedded: ${dtProgress.embedded}`);
      console.log(`      Reused in space: ${dtProgress.reusedInSpace}`);
      console.log(`      Failed: ${dtProgress.failed}`);
      if (dtProgress.completedForEmbedRevision) {
        console.log(`      Completed for Revision: ${dtProgress.completedForEmbedRevision}`);
      }
    }
  } else {
    console.log("  No progress recorded yet.");
  }
}

async function run() {
  console.log("▶ Corpus Re-embed & Reindex Pipeline starting...");

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
  
  if (args.includes("--status")) {
    printProgress();
    process.exit(0);
  }

  const symbols = targetTicker ? [targetTicker] : undefined;

  if (isPurgeLegacy) {
    console.log("⚠️  WARNING: You are about to PURGE legacy embedding space vectors!");
    const confirmed = await askConfirm("Type 'YES' to confirm you want to delete old vectors: ");
    if (!confirmed) {
      console.log("❌ Cancelled by operator.");
      process.exit(0);
    }
    
    const confirmStr = "purge-voyage-vectors"; // matching expected confirm string in purgeLegacyEmbeddingSpace
    const result = await purgeLegacyEmbeddingSpace({ docTypes, confirm: confirmStr, dryRun: isDryRun });
    if (!result.acquired) {
      console.error(`❌ Could not acquire lock. Busy running: ${result.busy?.group}`);
      process.exit(1);
    }
    
    console.log("✅ Purge Result:", JSON.stringify(result.result, null, 2));
    process.exit(0);
  }

  if (isDryRun) {
    console.log("  Running dry-run re-embed...");
    const result = await runCorpusReembedDryRun({ docTypes, symbols, maxTexts });
    if (!result.acquired) {
      console.error(`❌ Could not acquire lock. Busy running: ${result.busy?.group}`);
      process.exit(1);
    }
    console.log("✅ Dry-run Result:", JSON.stringify(result.result, null, 2));
    process.exit(0);
  }

  // Ask for confirmation for real run
  const confirmed = await askConfirm(`⚠️  Are you sure you want to start a real corpus re-embed run (consumes budget)? Type YES to confirm: `);
  if (!confirmed) {
    console.log("❌ Cancelled by operator.");
    process.exit(0);
  }

  const started = startCorpusReembedRun({ docTypes, symbols, maxTexts });
  if (!started.acquired) {
    console.error(`❌ Could not acquire lock. Busy running: ${started.busy?.group}`);
    process.exit(1);
  }

  console.log("✅ Background run started successfully! The process will continue in the background.");
  console.log("   Run with --status to check progress.");
}

run().catch((err) => {
  console.error("❌ Fatal error during reindexing:", err);
  process.exit(1);
});
