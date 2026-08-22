import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyVersionedMigrations, getDb } from "../src/lib/db";
import { insertDocumentChunkFts } from "../src/lib/db-learning";
import { hashContent } from "../src/lib/rag/chunk";
import { hydrateAccession } from "../src/lib/rag/hydrate-accession";
import { writeLocalArtifact } from "../src/lib/web-sources/sec-filings";

const ACCESSION = "0001045810-26-000123";
const CIK = "0001045810";
const PARENT_1A =
  "Item 1A. Risk Factors. Export-control changes could reduce data-center demand and impair a going-concern assumption.";
const ITEM7 =
  "Item 7. MD&A. Revenue grew and we raised full-year guidance on data-center demand.";

describe("hydrateAccession", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "hydrate-acc-"));

  beforeAll(() => {
    process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-hydrate-${randomUUID()}.db`)}`;
    process.env.DATA_DIR = dataDir;
    delete process.env.CORPUS_DIR;
    applyVersionedMigrations(getDb());
  });

  beforeEach(() => {
    getDb().exec(`
      DELETE FROM document_chunks_fts_index;
      DELETE FROM document_chunks_fts;
    `);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parent/1A from chunks.json + FTS without network", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("hydrate must not hit the network");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const chunk1A = {
      text: PARENT_1A,
      parent_text: PARENT_1A,
      content_hash: hashContent(PARENT_1A),
      section: "1A. Risk Factors",
      itemCode: "1A"
    };
    const chunk7 = {
      text: ITEM7,
      parent_text: ITEM7,
      content_hash: hashContent(ITEM7),
      section: "7. Management's Discussion and Analysis",
      itemCode: "7"
    };
    await writeLocalArtifact(CIK, ACCESSION, 1, "chunks.json", JSON.stringify([chunk1A, chunk7]));
    insertDocumentChunkFts(chunk1A.content_hash, "NVDA", "sec-edgar", ACCESSION, PARENT_1A);
    insertDocumentChunkFts(chunk7.content_hash, "NVDA", "sec-edgar", ACCESSION, ITEM7);

    const fromChunks = await hydrateAccession({
      accession: ACCESSION,
      itemCode: "1A",
      symbol: "NVDA"
    });
    expect(fromChunks.missedReason).toBeUndefined();
    expect(fromChunks.source).toBe("chunks.json");
    expect(fromChunks.text).toContain("Risk Factors");
    expect(fromChunks.text).toContain("going-concern");
    expect(fetchSpy).not.toHaveBeenCalled();

    const fromHash = await hydrateAccession({
      accession: `NVDA:${ACCESSION}:10-K`,
      content_hash: chunk1A.content_hash,
      symbol: "NVDA"
    });
    expect(fromHash.text).toContain("Export-control");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fail-opens on a miss without throwing", async () => {
    const missed = await hydrateAccession({ accession: "0000000000-00-000000", itemCode: "1A" });
    expect(missed.text).toBe("");
    expect(missed.missedReason).toBe("missing_local_copy");
  });
});
