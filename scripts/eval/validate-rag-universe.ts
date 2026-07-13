import fs from "node:fs";
import path from "node:path";
import { validateSecUniverseManifest } from "../../src/lib/rag/universe-manifest";

const manifestPath = path.resolve(process.argv[2] ?? "data/rag-universe-manifest.json");
const raw = fs.readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw) as unknown;
const issues = validateSecUniverseManifest(manifest);

if (issues.length === 0) {
  console.log(`SEC/RAG universe acceptance: PASS (${manifestPath})`);
} else {
  console.error(`SEC/RAG universe acceptance: FAIL (${issues.length} issue(s), ${manifestPath})`);
  for (const issue of issues.slice(0, 100)) {
    console.error(`- ${issue.code} ${issue.path}: ${issue.message}`);
  }
  if (issues.length > 100) console.error(`- ... ${issues.length - 100} additional issue(s)`);
  process.exitCode = 1;
}
