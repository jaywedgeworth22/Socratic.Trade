import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-fts-mirror-${randomUUID()}.db`)}`;
});

const KEY = { symbol: "HSY", source: "sec-edgar", accession: "0001628280-26-028682:1:hsy-20260329.htm" };

/**
 * Production 2026-09-09: the bounded FTS mirror resumed from `countDocumentChunkFts()` and used
 * that COUNT as a POSITIONAL offset into the chunk array.  `document_chunks_fts_index` is keyed
 * `(content_hash, symbol, source, accession)`, so two byte-identical chunks in one filing collapse
 * onto ONE row.  From the first duplicate the count trails the position forever, so the same slice
 * was re-mirrored on every ingest tick — 198 slices / 1,317,546ms of pinned event loop on 09-08 —
 * and `complete` never became true, so the filing was never marked ingested.
 */
function rowsWithDuplicateTail() {
  const rows: Array<{ contentHash: string; symbol: string; source: string; accession: string; text: string }> = [];
  for (let i = 0; i < 6; i++) {
    rows.push({ contentHash: `hash-unique-${i}`, ...KEY, text: `unique body ${i}` });
  }
  for (let i = 0; i < 6; i++) {
    rows.push({ contentHash: `hash-unique-${i}`, ...KEY, text: `unique body ${i}` });
  }
  rows.push({ contentHash: "hash-unique-tail", ...KEY, text: "tail body" });
  return rows;
}

describe("FTS mirror resume offset — convergence", () => {
  it("count-based resume trails the position once a document repeats chunk text", async () => {
    const { insertDocumentChunkFtsBatch, countDocumentChunkFts, ftsMirrorResumeOffset } = await import("../src/lib/db");
    const rows = rowsWithDuplicateTail();

    await insertDocumentChunkFtsBatch(rows.slice(0, 12));

    expect(countDocumentChunkFts(KEY)).toBe(6);
    expect(ftsMirrorResumeOffset(rows, KEY)).toBe(12);
  });

  it("mirrorFtsChunksBounded converges to complete on a document with duplicate chunks", async () => {
    const { mirrorFtsChunksBounded } = await import("../src/lib/rag/mirror-fts-bounded");
    const rows = rowsWithDuplicateTail();

    let last = -1;
    let guard = 0;
    let result = await mirrorFtsChunksBounded(rows, { resumeKey: KEY, gateStrategyWork: false });
    while (!result.complete && guard++ < 50) {
      expect(result.offset).toBeGreaterThan(last);
      last = result.offset;
      result = await mirrorFtsChunksBounded(rows, { resumeKey: KEY, gateStrategyWork: false });
    }
    expect(result.complete).toBe(true);
    expect(result.offset).toBe(rows.length);
    expect(guard).toBeLessThan(50);
  });

  it("re-running a fully mirrored document is a no-op that reports complete", async () => {
    const { mirrorFtsChunksBounded } = await import("../src/lib/rag/mirror-fts-bounded");
    const rows = rowsWithDuplicateTail();
    const again = await mirrorFtsChunksBounded(rows, { resumeKey: KEY, gateStrategyWork: false });
    expect(again.complete).toBe(true);
    expect(again.offset).toBe(rows.length);
  });
});

describe("document_chunks_fts_index occurrence index (migration 88)", () => {
  it("resolves an occurrence lookup with a SEARCH, not a full-index SCAN", async () => {
    const { getDb } = await import("../src/lib/db");
    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT content_hash FROM document_chunks_fts_index
         WHERE symbol = ? AND source = ? AND accession = ?`
      )
      .all(KEY.symbol, KEY.source, KEY.accession) as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(" | ");
    expect(detail).toContain("idx_document_chunks_fts_index_occurrence");
    expect(detail).toContain("SEARCH");
  });
});
