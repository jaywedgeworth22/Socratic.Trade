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
  politeFetch: vi.fn()
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
        filedAt: "2026-07-15"
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
  });
});
