import {
  claimSecIngestTasks,
  advanceSecIngestTask,
  failSecIngestTask,
  heartbeatSecIngestTask,
  SecIngestTask
} from "../db-rag-ingest";
import { politeFetchText } from "../web-sources/http";
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

  constructor(private intervalMs = 5000) {}

  async start() {
    if (this.active) return;
    this.active = true;
    this.intervalId = setInterval(() => this.runTick(), this.intervalMs);
  }

  async stop() {
    this.active = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async runTick() {
    const db = getDb();
    const activeJobs = db.prepare("SELECT id FROM sec_ingest_jobs WHERE status = 'running'").all() as any[];

    for (const job of activeJobs) {
      const tasks = claimSecIngestTasks(job.id, {
        owner: this.workerId,
        leaseMs: 60000,
        limit: 5
      });

      for (const task of tasks) {
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
    }
  }

  async processTask(task: SecIngestTask) {
    const leaseToken = task.leaseToken || "";
    const owner = task.leaseOwner || this.workerId;
    const documentName = task.documentName || "document.html";

    const heartbeat = () => {
      heartbeatSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        leaseMs: 60000
      });
    };

    const checkpoint = task.checkpoint;

    if (checkpoint === "discovered") {
      heartbeat();
      const content = await politeFetchText(task.payload.url as string);
      await writeLocalArtifact(task.cik, task.accession, 1, `raw-${documentName}`, content);

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
      const content = await readLocalArtifact(task.cik, task.accession, 1, `raw-${documentName}`);
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
      const content = await readLocalArtifact(task.cik, task.accession, 1, `raw-${documentName}`);
      if (!content) throw new Error("Raw content artifact missing");

      let sections: any[];
      if (documentName.endsWith(".xml")) {
        sections = [{ title: "XML Document", text: content }];
      } else {
        const parsed = parseFilingHtml(content);
        sections = parsed.sections;
      }
      await writeLocalArtifact(task.cik, task.accession, 1, "sections.json", JSON.stringify(sections));

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
      const content = await readLocalArtifact(task.cik, task.accession, 1, `raw-${documentName}`);
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
      const rawContent = await readLocalArtifact(task.cik, task.accession, 1, `raw-${documentName}`);
      const sectionsJson = await readLocalArtifact(task.cik, task.accession, 1, "sections.json");
      if (!rawContent || !sectionsJson) throw new Error("Parsed/Raw artifacts missing");

      const sections = JSON.parse(sectionsJson);
      const doc = {
        text: rawContent,
        doc_id: task.accession,
        ticker: task.symbol,
        title: `${task.symbol} ${task.payload.docType || "Filing"}`,
        doc_type: task.payload.docType as string,
        source: "sec-edgar",
        published_at: task.payload.filedAt as string,
        sections
      };

      const chunks = chunkDocument(doc, { maxTokens: 400, overlapRatio: 0.15 });
      await writeLocalArtifact(task.cik, task.accession, 1, "chunks.json", JSON.stringify(chunks));

      for (const chunk of chunks) {
        insertDocumentChunkFts(
          chunk.content_hash,
          task.symbol,
          "sec-edgar",
          task.accession,
          chunk.text
        );
      }

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
      const rawContent = await readLocalArtifact(task.cik, task.accession, 1, `raw-${documentName}`);
      const sectionsJson = await readLocalArtifact(task.cik, task.accession, 1, "sections.json");
      if (!rawContent || !sectionsJson) throw new Error("Parsed/Raw artifacts missing");

      const sections = JSON.parse(sectionsJson);
      const doc = {
        text: rawContent,
        doc_id: task.accession,
        ticker: task.symbol,
        title: `${task.symbol} ${task.payload.docType || "Filing"}`,
        doc_type: task.payload.docType as string,
        source: "sec-edgar",
        published_at: task.payload.filedAt as string,
        sections
      };

      const res = await storeDocument(doc, "local", {
        maxTokens: 400,
        overlapRatio: 0.15
      });

      if (!res.documentComplete) {
        throw new Error("Ingestion budget or capacity exceeded mid-task");
      }

      await writeLocalArtifact(task.cik, task.accession, 1, "storeResult.json", JSON.stringify(res));

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
      const storeResultJson = await readLocalArtifact(task.cik, task.accession, 1, "storeResult.json");
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
