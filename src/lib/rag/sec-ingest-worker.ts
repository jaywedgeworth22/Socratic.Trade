import {
  claimSecIngestTasks,
  advanceSecIngestTask,
  deferSecIngestTask,
  failSecIngestTask,
  heartbeatSecIngestTask,
  reconcileSecIngestJob,
  SecIngestTask
} from "../db-rag-ingest";
import { pineconeWuExhaustedUntil } from "../pinecone-wu-breaker";
import { pineconeBackfillPaceGate } from "../pinecone-monthly-pace";
import { politeFetchText } from "../web-sources/http";
import { yieldEventLoop } from "../slow-sync-guard";
import { parseFilingHtml } from "../web-sources/sec-parser";
import { ingestCompanyFacts, parseAndSaveForm4 } from "../web-sources/sec-facts";
import { storeDocument } from "../vector-db";
import { readLocalArtifact, writeLocalArtifact } from "../web-sources/sec-filings";
import { insertDocumentChunkFts, getDb } from "../db";
import { chunkDocument } from "./chunk";
import crypto from "crypto";

export class SecIngestWorker {
  private active = false;
  private intervalId: NodeJS.Timeout | null = null;
  private workerId = `worker:${crypto.randomUUID().slice(0, 8)}`;
  private tickInFlight = false;

  constructor(private intervalMs = 5000) {}

  async start() {
    if (this.active) return;
    this.active = true;
    // Serialize ticks: fetching/embedding routinely outlasts intervalMs, and an unguarded
    // interval would start overlapping runTick() calls that claim extra batches and run
    // EDGAR/Voyage/Pinecone work concurrently. Skip the tick while one is still in flight.
    this.intervalId = setInterval(() => {
      if (this.tickInFlight) return;
      this.tickInFlight = true;
      void this.runTick()
        .catch((err) => console.error("[SecIngestWorker] Tick failed:", err instanceof Error ? err.message : String(err)))
        .finally(() => {
          this.tickInFlight = false;
        });
    }, this.intervalMs);
  }

  async stop() {
    this.active = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** One polling pass. Public (like `processTask`) so tests can drive a single tick
   *  deterministically instead of racing the 5s interval. */
  async runTick() {
    // Monthly write-unit PACE guard. This queue IS the bulk/backfill lane, so it is the one
    // producer the pace guard throttles: when the month-end projection exceeds
    // PINECONE_MONTHLY_WU_BUDGET we simply stop CLAIMING NEW tasks. Already-leased tasks are
    // untouched (their leases expire and they become claimable again once the throttle lifts or
    // the month rolls over), incremental filing ingest keeps running, and retrieval is never
    // affected. Default-off: with no budget configured this is an env read and nothing else.
    const paceGate = await pineconeBackfillPaceGate("backfill");
    if (paceGate.throttled) return;

    const db = getDb();
    const activeJobs = db.prepare("SELECT id FROM sec_ingest_jobs WHERE status = 'running'").all() as any[];

    for (const job of activeJobs) {
      const tasks = claimSecIngestTasks(job.id, {
        owner: this.workerId,
        leaseMs: 60000,
        limit: 5
      });

      for (const task of tasks) {
        // Each task chains synchronous extract/chunk/persist segments; yield between tasks so
        // queued HTTP requests get served (2026-08-10 event-loop stall incident).
        await yieldEventLoop();
        try {
          await this.processTask(task);
        } catch (err: any) {
          console.error(`[SecIngestWorker] Task ${task.id} failed:`, err.message);
          failSecIngestTask({
            taskId: task.id,
            owner: this.workerId,
            leaseToken: task.leaseToken || "",
            retryable: true,
            errorType: "worker-error",
            error: err.message
          });
        }
      }

      // Nothing else flips a job from 'running' to a terminal status once its tasks finish — the
      // seeder seals intake up front but does not itself watch for completion. Reconcile here (cheap,
      // idempotent no-op unless intake is sealed and every task has reached a terminal status) so a
      // job whose tasks all completed/dead-lettered doesn't sit at 'running' forever.
      reconcileSecIngestJob(job.id);
    }
  }

  async processTask(task: SecIngestTask) {
    const leaseToken = task.leaseToken || "";
    const owner = task.leaseOwner || this.workerId;
    const documentName = task.documentName || "document.html";
    const sequence = task.sequence ?? 1;

    const heartbeat = () => {
      heartbeatSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        leaseMs: 60000
      });
    };

    // Multi-document accessions: a filing can queue several documents (primary HTML, exhibits,
    // ownership XML), each its own task with a distinct sequence/documentName. The vector
    // document id must carry that identity: storeDocument defaults its managed-ledger
    // documentKey to doc_id and keeps only ONE active head per (tenant_scope, source,
    // document_key), so a bare-accession id would let document B's commit supersede document
    // A's vectors — and every document's chunks would collide on `<accession>#c001` citations.
    const vectorDocId = `${task.accession}:${sequence}:${documentName}`;

    const checkpoint = task.checkpoint;

    if (checkpoint === "discovered") {
      heartbeat();
      let content = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      if (!content) {
        try {
          content = await politeFetchText(task.payload.url as string);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // EDGAR 403 = IP-level automated-access block, not a fault of this task. Mirror the
          // WU-breaker deferral (attempt refunded) instead of failing: exponential failure
          // backoff would burn all stage attempts into a block that outlives them and
          // dead-letter healthy filings — which is exactly what happened on 2026-08-09.
          if (/^HTTP 403 /.test(msg)) {
            const { secLimiter } = await import("../web-sources/sec-limiter");
            const until = secLimiter.pausedUntilIso() ?? new Date(Date.now() + 10 * 60_000).toISOString();
            deferSecIngestTask({
              taskId: task.id,
              owner,
              leaseToken,
              deferUntil: until,
              reasonType: "edgar_403_deferred",
              reason: `EDGAR 403 (automated-access block); deferred until ${until}`
            });
            return;
          }
          throw err;
        }
        await writeLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`, content);
        // writeLocalArtifact swallows filesystem errors, so the await above does not prove the raw
        // filing was persisted. Verify before advancing: otherwise every retry starts from
        // `fetched`, reads a missing artifact, and dead-letters a recoverable filing.
        const persisted = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
        if (persisted === null || persisted.length !== content.length) {
          throw new Error("Raw artifact write verification failed (artifact missing or truncated)");
        }
      }

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "discovered",
        nextCheckpoint: "fetched",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from discovered to fetched");
      return;
    }

    if (checkpoint === "fetched") {
      heartbeat();
      const content = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      if (!content || content.length < 100) {
        throw new Error("Validation failed: empty or tiny content");
      }
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "fetched",
        nextCheckpoint: "validated",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from fetched to validated");
      return;
    }

    if (checkpoint === "validated") {
      heartbeat();
      const content = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      if (!content) throw new Error("Raw content artifact missing");

      let sections: any[];
      if (documentName.endsWith(".xml")) {
        sections = [{ itemCode: "0", itemTitle: "XML Document", text: content }];
      } else {
        // Form-aware title canonicalization: only a proven 10-K gets the 10-K
        // Item-code -> title map; other forms keep raw parsed titles.
        const parsed = parseFilingHtml(content, {
          formType: typeof task.payload.docType === "string" ? task.payload.docType : undefined
        });
        sections = parsed.sections;
      }
      await writeLocalArtifact(task.cik, task.accession, sequence, "sections.json", JSON.stringify(sections));

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "validated",
        nextCheckpoint: "parsed",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from validated to parsed");
      return;
    }

    if (checkpoint === "parsed") {
      heartbeat();
      const content = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      if (!content) throw new Error("Raw content artifact missing");

      if (documentName.endsWith(".xml")) {
        parseAndSaveForm4(content, task.cik, task.accession);
      } else {
        await ingestCompanyFacts(task.cik);
      }
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "parsed",
        nextCheckpoint: "facts_extracted",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from parsed to facts_extracted");
      return;
    }

    if (checkpoint === "facts_extracted") {
      heartbeat();
      const rawContent = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      const sectionsJson = await readLocalArtifact(task.cik, task.accession, sequence, "sections.json");
      if (!rawContent || !sectionsJson) throw new Error("Parsed/Raw artifacts missing");

      const sections = JSON.parse(sectionsJson);
      const doc = {
        text: rawContent,
        doc_id: vectorDocId,
        ticker: task.symbol,
        title: `${task.symbol} ${task.payload.docType || "Filing"}`,
        doc_type: task.payload.docType as string,
        source: "sec-edgar",
        published_at: task.payload.filedAt as string,
        // Point-in-time correctness: pass the SEC acceptance timestamp through when the queued
        // payload carries it, so chunkDocument does not fall back to a date-only stamp that
        // makes same-day filings retrievable for as-of queries earlier that day.
        ...(typeof task.payload.acceptanceDateTime === "string" && task.payload.acceptanceDateTime
          ? { acceptance_datetime: task.payload.acceptanceDateTime }
          : {}),
        sections
      };

      const chunks = chunkDocument(doc, { maxTokens: 400, overlapRatio: 0.15 });
      await writeLocalArtifact(task.cik, task.accession, sequence, "chunks.json", JSON.stringify(chunks));
      // NOTE: FTS rows are deliberately NOT written here. Lexical indexing happens in the
      // embed_queued stage AFTER storeDocument commits, so retrieval can never surface chunks
      // from a document that failed or is still retrying its vector commit.

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "facts_extracted",
        nextCheckpoint: "chunked",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from facts_extracted to chunked");
      return;
    }

    if (checkpoint === "chunked") {
      heartbeat();
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "chunked",
        nextCheckpoint: "embed_queued",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from chunked to embed_queued");
      return;
    }

    if (checkpoint === "embed_queued") {
      heartbeat();
      // Monthly Pinecone write-unit breaker: park the task until the marker expires BEFORE
      // reading artifacts or spending a single embed token. This is a clean deferral (attempt
      // refunded, next_retry_at = breaker expiry), NOT a retryable failure — the exponential
      // failure backoff would otherwise grind hourly retries into a quota that cannot recover
      // before the 1st of next month, and eventually dead-letter healthy filings.
      const wuUntil = pineconeWuExhaustedUntil();
      if (wuUntil) {
        deferSecIngestTask({
          taskId: task.id,
          owner,
          leaseToken,
          deferUntil: wuUntil,
          reasonType: "wu_exhausted_deferred",
          reason: `Pinecone monthly write units exhausted; deferred until ${wuUntil}`
        });
        return;
      }
      const rawContent = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      const sectionsJson = await readLocalArtifact(task.cik, task.accession, sequence, "sections.json");
      if (!rawContent || !sectionsJson) throw new Error("Parsed/Raw artifacts missing");

      const sections = JSON.parse(sectionsJson);
      const doc = {
        text: rawContent,
        doc_id: vectorDocId,
        ticker: task.symbol,
        title: `${task.symbol} ${task.payload.docType || "Filing"}`,
        doc_type: task.payload.docType as string,
        source: "sec-edgar",
        published_at: task.payload.filedAt as string,
        // Same acceptance pass-through as the chunk stage: preserve the accepted-at timestamp
        // for point-in-time (as-of) retrieval instead of a date-only fallback.
        ...(typeof task.payload.acceptanceDateTime === "string" && task.payload.acceptanceDateTime
          ? { acceptance_datetime: task.payload.acceptanceDateTime }
          : {}),
        sections
      };

      // Keep the task lease alive across the long embed: storeDocument batches Voyage/Pinecone
      // work and can easily outlast the 60s lease, after which another worker would reclaim the
      // task and duplicate provider work. Heartbeat on a timer for the duration of the call.
      const leaseHeartbeat = setInterval(heartbeat, 20_000);
      leaseHeartbeat.unref?.();
      let res;
      try {
        res = await storeDocument(doc, "local", {
          maxTokens: 400,
          overlapRatio: 0.15
        });
      } finally {
        clearInterval(leaseHeartbeat);
      }

      if (!res.documentComplete) {
        // Breaker tripped mid-call (raced the gate above): same clean deferral, not a failure.
        if (res.wuExhausted) {
          deferSecIngestTask({
            taskId: task.id,
            owner,
            leaseToken,
            deferUntil: res.wuExhaustedUntil ?? new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
            reasonType: "wu_exhausted_deferred",
            reason: `Pinecone monthly write units exhausted mid-store; deferred until ${res.wuExhaustedUntil ?? "next check"}`
          });
          return;
        }
        throw new Error("Ingestion budget or capacity exceeded mid-task");
      }

      await writeLocalArtifact(task.cik, task.accession, sequence, "storeResult.json", JSON.stringify(res));

      // Lexical (FTS) indexing happens HERE — only after storeDocument reported a complete
      // committed document — so hybrid retrieval can never surface chunks whose vector commit
      // failed or is still retrying. insertDocumentChunkFts is idempotent per occurrence
      // (delete+insert keyed on symbol/source/accession/hash), so a retry of this stage after a
      // failed checkpoint advance does not duplicate rows.
      const chunksJson = await readLocalArtifact(task.cik, task.accession, sequence, "chunks.json");
      const ftsChunks = chunksJson
        ? JSON.parse(chunksJson)
        : chunkDocument(doc, { maxTokens: 400, overlapRatio: 0.15 });
      // Match storeDocument's doc_id / chunk_occurrences.accession (vectorDocId), not the bare
      // SEC accession, so corpus-wide lexical joins succeed for worker-ingested filings.
      for (const chunk of ftsChunks) {
        insertDocumentChunkFts(
          chunk.content_hash,
          task.symbol,
          "sec-edgar",
          vectorDocId,
          chunk.text
        );
      }

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "embed_queued",
        nextCheckpoint: "embedded",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from embed_queued to embedded");
      return;
    }

    if (checkpoint === "embedded") {
      heartbeat();
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "embedded",
        nextCheckpoint: "index_queued",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from embedded to index_queued");
      return;
    }

    if (checkpoint === "index_queued") {
      heartbeat();
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "index_queued",
        nextCheckpoint: "indexed",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from index_queued to indexed");
      return;
    }

    if (checkpoint === "indexed") {
      heartbeat();
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "indexed",
        nextCheckpoint: "verified",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from indexed to verified");
      return;
    }

    if (checkpoint === "verified") {
      heartbeat();
      const storeResultJson = await readLocalArtifact(task.cik, task.accession, sequence, "storeResult.json");
      if (!storeResultJson) throw new Error("storeResult artifact missing");
      const res = JSON.parse(storeResultJson);

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "verified",
        nextCheckpoint: "complete",
        observations: {
          chunks: res?.indexed ?? 0,
          tokens: (res?.attempted ?? 0) * 400
        },
        verification: { verified: true },
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from verified to complete");
      return;
    }
  }
}

// ── Process-level singleton wiring ──────────────────────────────────────────
// Mirrors the self-gated singleton pattern used by startCongressStream (congress-stream.ts) and the
// shutdown-hook registration pattern used by durable-state.ts: opt-in via env, idempotent start,
// globalThis-pinned so Next.js HMR / a test runner's module re-evaluation cannot spawn a second
// interval or register duplicate signal handlers on the one real process.

function flagOn(value: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

/** Opt-in gate (default OFF). The durable checkpoint state machine and DB primitives
 *  (db-rag-ingest.ts) are production-ready, but nothing seeds jobs automatically — jobs only exist
 *  after an explicit POST /api/admin/sec-ingest {action:"seed"} call. See
 *  docs/rollouts/2026-07-18-sec-ingest-worker-wiring.md. */
export function secIngestWorkerEnabled(): boolean {
  return flagOn(process.env.SEC_INGEST_WORKER_ENABLED);
}

type SecIngestWorkerHost = typeof globalThis & {
  __secIngestWorkerInstance?: SecIngestWorker;
  __secIngestWorkerShutdownHooksRegistered?: boolean;
};
const host = globalThis as SecIngestWorkerHost;

function registerSecIngestShutdownHooksOnce(): void {
  if (host.__secIngestWorkerShutdownHooksRegistered) return;
  host.__secIngestWorkerShutdownHooksRegistered = true;
  const shutdown = () => {
    void stopSecIngestWorker();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/** Idempotent: start the SEC ingest worker once, only when SEC_INGEST_WORKER_ENABLED. Called
 *  unconditionally from background-worker-startup.ts, matching how startStreams() calls each
 *  individually-gated stream starter. */
export function startSecIngestWorker(): void {
  if (!secIngestWorkerEnabled()) return;
  if (host.__secIngestWorkerInstance) return;
  const worker = new SecIngestWorker();
  host.__secIngestWorkerInstance = worker;
  registerSecIngestShutdownHooksOnce();
  void worker.start();
}

/** Stop the worker (tests / graceful shutdown). No-op if never started. */
export async function stopSecIngestWorker(): Promise<void> {
  const worker = host.__secIngestWorkerInstance;
  if (!worker) return;
  host.__secIngestWorkerInstance = undefined;
  await worker.stop();
}
