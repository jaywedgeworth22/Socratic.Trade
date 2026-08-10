import { describe, it, expect, beforeAll, vi } from "vitest";
import { getDb, applyVersionedMigrations } from "../src/lib/db";
import { createSecIngestJob, enqueueSecIngestTask, getSecIngestTask, claimSecIngestTasks, transitionSecIngestJob } from "../src/lib/db-rag-ingest";
import { SecIngestWorker } from "../src/lib/rag/sec-ingest-worker";
import { politeFetchText, politeFetch } from "../src/lib/web-sources/http";
import { storeDocument } from "../src/lib/vector-db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-worker-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-sec-worker-data-${runId}`);
  const db = getDb();
  applyVersionedMigrations(db);
});

vi.mock("../src/lib/web-sources/http", () => ({
  politeFetchText: vi.fn(),
  politeFetch: vi.fn(),
  BROWSER_UA: "Mozilla/5.0 test"
}));

vi.mock("../src/lib/vector-db", () => ({
  storeDocument: vi.fn()
}));

describe("SEC Ingestion Worker and State Machine (P5)", () => {
  it("should claim a discovered task, run the pipeline checkpoints, and mark it complete", async () => {
    const db = getDb();
    const accession = "0000320193-26-000010";

    const job = createSecIngestJob({
      idempotencyKey: "idemp-123",
      corpusRevision: "corp-v1"
    });
    const jobId = job.id;

    transitionSecIngestJob(jobId, "running");

    const { task } = enqueueSecIngestTask({
      jobId,
      accession,
      cik: "0000320193",
      symbol: "AAPL",
      payload: {
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/aapl-20260715.htm",
        docType: "10-K",
        filedAt: "2026-07-15",
        acceptanceDateTime: "2026-07-15T21:37:12.000Z"
      }
    });

    expect(task.checkpoint).toBe("discovered");

    const claimed = claimSecIngestTasks(jobId, {
      owner: "test-worker",
      leaseMs: 60000,
      limit: 1
    });
    expect(claimed).toHaveLength(1);
    const taskToProcess = claimed[0]!;

    // Mocks
    vi.mocked(politeFetchText).mockResolvedValueOnce("<html><body>Item 1. Business<p>AAPL makes iPhones and lots of other consumer electronics that people buy all over the world.</p></body></html>");
    vi.mocked(politeFetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found"
    } as any);
    vi.mocked(storeDocument).mockResolvedValueOnce({
      skipped: false,
      attempted: 1,
      indexed: 1,
      documentComplete: true
    } as any);

    // Process step-by-step re-claiming the task at each stage
    const worker = new SecIngestWorker();
    let currentTask = taskToProcess;

    while (currentTask.checkpoint !== "complete") {
      await worker.processTask(currentTask);

      const claimedNext = claimSecIngestTasks(jobId, {
        owner: "test-worker",
        leaseMs: 60000,
        limit: 1
      });
      if (claimedNext.length === 0) {
        break;
      }
      currentTask = claimedNext[0]!;
    }

    const finalTask = getSecIngestTask(task.id);
    expect(finalTask).not.toBeNull();
    expect(finalTask!.checkpoint).toBe("complete");
    expect(finalTask!.status).toBe("complete");
    expect(finalTask!.observedChunks).toBe(1);

    // Point-in-time: the queued acceptance timestamp must flow into the stored document, not a
    // date-only fallback derived from filedAt.
    const storeCall = vi.mocked(storeDocument).mock.calls[0]?.[0] as any;
    expect(storeCall.acceptance_datetime).toBe("2026-07-15T21:37:12.000Z");

    // Multi-document accessions: the vector document id must carry the task's document identity
    // (sequence + documentName) so a second document in the same accession can never supersede
    // this one's managed-ledger head or collide on chunk citations.
    expect(storeCall.doc_id).toBe(`${accession}:1:document.html`);

    // Lexical FTS rows are written only after storeDocument reports a committed document —
    // and they ARE written (the worker pipeline is the FTS producer for queued ingests).
    // Accession key matches storeDocument doc_id / chunk_occurrences (vectorDocId), not bare SEC accession.
    const ftsRows = db.prepare(
      "SELECT symbol, accession FROM document_chunks_fts WHERE accession = ?"
    ).all(`${accession}:1:document.html`) as any[];
    expect(ftsRows.length).toBeGreaterThan(0);
    expect(ftsRows[0].symbol).toBe("AAPL");
    expect(ftsRows[0].accession).toBe(`${accession}:1:document.html`);
  });
});

describe("EDGAR 403 handling and dead-letter requeue (2026-08-09 outage class)", () => {
  function makeClaimedTask(idempotencyKey: string, accession: string) {
    const job = createSecIngestJob({ idempotencyKey, corpusRevision: "corp-v1" });
    transitionSecIngestJob(job.id, "running");
    enqueueSecIngestTask({
      jobId: job.id,
      accession,
      cik: "0000798354",
      symbol: "FI",
      payload: {
        url: `https://www.sec.gov/Archives/edgar/data/798354/${accession.replace(/-/g, "")}/doc.htm`,
        docType: "10-Q",
        filedAt: "2026-06-30",
        acceptanceDateTime: "2026-06-30T21:00:00.000Z"
      }
    });
    const claimed = claimSecIngestTasks(job.id, { owner: "test-worker", leaseMs: 60000, limit: 1 });
    expect(claimed).toHaveLength(1);
    return { jobId: job.id, task: claimed[0]! };
  }

  it("defers (not fails) a task when EDGAR answers 403, refunding the stage attempt", async () => {
    const { task } = makeClaimedTask("idemp-403-defer", "0000798354-26-000031");
    vi.mocked(politeFetchText).mockRejectedValueOnce(
      new Error("HTTP 403 for https://www.sec.gov/Archives/edgar/data/798354/000079835426000031/doc.htm")
    );

    const worker = new SecIngestWorker();
    await worker.processTask(task);

    const after = getSecIngestTask(task.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("retry_wait");
    expect(after!.lastErrorType).toBe("edgar_403_deferred");
    // Deferral refunds the attempt the claim consumed — a persistent block must never march the
    // task toward dead_letter.
    expect(after!.stageAttempts).toBe(0);
    expect(after!.checkpoint).toBe("discovered");
  });

  it("requeues dead-lettered tasks and reopens their complete_with_errors job", async () => {
    const { jobId, task } = makeClaimedTask("idemp-requeue", "0000798354-26-000032");
    const { failSecIngestTask, sealSecIngestJobIntake, reconcileSecIngestJob, requeueSecIngestDeadLetters, getSecIngestJob } =
      await import("../src/lib/db-rag-ingest");

    expect(sealSecIngestJobIntake(jobId, 1)).toBe(true);
    const failed = failSecIngestTask({
      taskId: task.id,
      owner: "test-worker",
      leaseToken: task.leaseToken || "",
      retryable: false,
      errorType: "worker-error",
      error: "HTTP 403 for https://www.sec.gov/Archives/..."
    });
    expect(failed.applied).toBe(true);
    expect(getSecIngestTask(task.id)!.status).toBe("dead_letter");
    expect(reconcileSecIngestJob(jobId)).toBe("complete_with_errors");

    const result = requeueSecIngestDeadLetters({ jobIds: [jobId] });
    expect(result.requeuedTasks).toBe(1);
    expect(result.reopenedJobs).toBe(1);

    const after = getSecIngestTask(task.id)!;
    expect(after.status).toBe("retry_wait");
    expect(after.stageAttempts).toBe(0);
    expect(getSecIngestJob(jobId)!.status).toBe("running");

    // The requeued task is claimable again once its next_retry_at passes.
    const reclaimed = claimSecIngestTasks(jobId, {
      owner: "test-worker",
      leaseMs: 60000,
      limit: 1,
      now: new Date(Date.now() + 60_000)
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.id).toBe(task.id);
  });
});

describe("insertDocumentChunkFtsBatch (2026-08-10 lock-contention fix)", () => {
  it("writes identical rows to the per-chunk loop, in ONE transaction", async () => {
    const { insertDocumentChunkFts, insertDocumentChunkFtsBatch } = await import("../src/lib/db-learning");
    const rows = [
      { contentHash: "hash-a", symbol: "AAPL", source: "sec-edgar", accession: "acc-batch-test", text: "alpha text" },
      { contentHash: "hash-b", symbol: "AAPL", source: "sec-edgar", accession: "acc-batch-test", text: "beta text" },
      { contentHash: "hash-c", symbol: "AAPL", source: "sec-edgar", accession: "acc-batch-test", text: "gamma text" }
    ];

    insertDocumentChunkFtsBatch(rows);
    const batchRows = getDb()
      .prepare("SELECT content_hash, text FROM document_chunks_fts WHERE accession = ? ORDER BY content_hash")
      .all("acc-batch-test") as Array<{ content_hash: string; text: string }>;
    expect(batchRows).toHaveLength(3);
    expect(batchRows.map((r) => r.content_hash)).toEqual(["hash-a", "hash-b", "hash-c"]);

    // Re-running with the per-chunk loop against the SAME identity must produce the same final
    // rows (idempotent delete+insert), proving the batch path is a drop-in replacement.
    for (const row of rows) {
      insertDocumentChunkFts(row.contentHash, row.symbol, row.source, row.accession, row.text);
    }
    const loopRows = getDb()
      .prepare("SELECT content_hash, text FROM document_chunks_fts WHERE accession = ? ORDER BY content_hash")
      .all("acc-batch-test") as Array<{ content_hash: string; text: string }>;
    expect(loopRows).toEqual(batchRows);
  });

  it("no-ops on an empty array instead of opening an empty transaction", async () => {
    const { insertDocumentChunkFtsBatch } = await import("../src/lib/db-learning");
    expect(() => insertDocumentChunkFtsBatch([])).not.toThrow();
  });
});
