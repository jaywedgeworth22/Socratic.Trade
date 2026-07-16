import { describe, it, expect, beforeAll, vi } from "vitest";
import { getDb, applyVersionedMigrations } from "../src/lib/db";
import { runEvaluationHarness } from "../scripts/eval/rag-eval-harness";
import { insertDocumentChunkFts } from "../src/lib/db-learning";
import { retrieveContextDetailed } from "../src/lib/vector-db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { enqueueSecIngestTask } from "../src/lib/db-rag-ingest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-eval-harness-${randomUUID()}.db`)}`;
  const db = getDb();
  applyVersionedMigrations(db);
});

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    retrieveContextDetailed: vi.fn()
  };
});

describe("RAG Evaluation Harness (P7)", () => {
  it("should execute evaluation queries, match golden set snippet/accession, and calculate metrics", async () => {
    const db = getDb();

    // Map CIK 0000320193 to AAPL in tasks table
    db.prepare(`
      INSERT INTO sec_ingest_jobs (id, idempotency_key, corpus_revision, status, created_at, updated_at)
      VALUES ('job1', 'idemp-1', 'corp-1', 'running', datetime('now'), datetime('now'))
    `).run();

    enqueueSecIngestTask({
      id: "task1",
      jobId: "job1",
      accession: "acc1",
      cik: "0000320193",
      symbol: "AAPL"
    });

    // Insert golden set evaluation criteria
    db.prepare(`
      INSERT INTO sec_eval_golden_set (id, query, expected_cik, expected_accession, expected_text_snippet, category)
      VALUES ('golden1', 'iPhone 17 layout', '0000320193', 'acc1', 'iPhone 17 details', 'product')
    `).run();

    // Populate FTS table with matching chunk
    insertDocumentChunkFts(
      "hash1",
      "AAPL",
      "sec-edgar",
      "acc1",
      "Our upcoming product lineup includes the iPhone 17 details and new camera sensors."
    );

    // Mock vector search returning something unrelated
    vi.mocked(retrieveContextDetailed).mockResolvedValueOnce([]);

    // Run harness
    const metrics = await runEvaluationHarness();

    expect(metrics).not.toBeNull();
    expect(metrics.count).toBe(1);
    expect(metrics.recallAt10).toBe(1);
    expect(metrics.recallAt50).toBe(1);
    expect(metrics.ndcg).toBeGreaterThan(0.9); // rank 1 = 1 / log2(2) = 1
  });
});
