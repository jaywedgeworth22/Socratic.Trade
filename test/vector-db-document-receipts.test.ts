import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-vector-receipts-${randomUUID()}.db`)}`;

const mocks = vi.hoisted(() => {
  const upsert = vi.fn(async (_input: {
    records: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>;
  }) => undefined);
  const listPaginated = vi.fn();
  const fetchRecords = vi.fn();
  const update = vi.fn(async () => undefined);
  const deleteMany = vi.fn(async () => undefined);
  const index = vi.fn(() => ({
    upsert,
    query: vi.fn(),
    listPaginated,
    fetch: fetchRecords,
    update,
    deleteMany
  }));
  return {
    upsert,
    index,
    listPaginated,
    fetchRecords,
    update,
    deleteMany,
    listIndexes: vi.fn(async () => ({ indexes: [{ name: "socratic-trade" }] })),
    createIndex: vi.fn(async () => undefined),
    describeIndex: vi.fn(async () => ({ dimension: 1024, metric: "cosine" })),
    embed: vi.fn(async () => ({ data: [{ embedding: [0.1, 0.2] }] }))
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      createIndex: mocks.createIndex,
      describeIndex: mocks.describeIndex,
      Index: mocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed };
  })
}));

beforeAll(async () => {
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.VECTOR_ENABLE_RERANK = "off";
  process.env.HYBRID_RETRIEVAL = "off";
  const { getDb } = await import("../src/lib/db");
  getDb();
}, 60_000);

afterAll(() => {
  for (const key of [
    "DATABASE_URL",
    "PINECONE_API_KEY",
    "VOYAGE_API_KEY",
    "PINECONE_INDEX_READY_WAIT_MS",
    "VECTOR_EMBED_BATCH_DELAY_MS",
    "VECTOR_ENABLE_RERANK",
    "HYBRID_RETRIEVAL"
  ]) delete process.env[key];
});

describe("storeDocument receipt transaction", () => {
  it("rolls back document_chunks when chunk_occurrences fails, then completes idempotently", async () => {
    const { getDb } = await import("../src/lib/db");
    const { storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    db.exec(`
      CREATE TRIGGER fail_test_chunk_occurrence
      BEFORE INSERT ON chunk_occurrences
      BEGIN
        SELECT RAISE(ABORT, 'synthetic chunk occurrence fault');
      END;
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = {
      text: "Management discussed revenue growth, durable demand, and margin expansion.",
      doc_id: "FMP-EARNINGS-TRANSCRIPT:AAPL:2026:Q1",
      ticker: "AAPL",
      title: "AAPL earnings call 2026 Q1",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-04-20T20:00:00.000Z",
      acceptance_datetime: "2026-04-21T01:00:00.000Z"
    };

    const failed = await storeDocument(input);
    expect(failed).toMatchObject({
      indexed: 1,
      error: "document-receipt-write-failed",
      documentComplete: false
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM document_chunks").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences").get()).toEqual({ count: 0 });

    db.exec("DROP TRIGGER fail_test_chunk_occurrence");
    const completed = await storeDocument(input);
    expect(completed).toMatchObject({ attempted: 1, indexed: 1, documentComplete: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM document_chunks").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences").get()).toEqual({ count: 1 });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // Failed receipt: pending upsert only. Successful retry: pending + committed upserts.
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    const committedRecord = mocks.upsert.mock.calls.at(-1)![0].records[0];
    expect(committedRecord.metadata).toMatchObject({
      ingest_state: "committed",
      receipt_required: true,
      tenant_scope: "shared:operator",
      parser_revision: "v1",
      embed_revision: "v1",
      chunk_ordinal: 1
    });
    expect(db.prepare(`
      SELECT c.state AS commit_state, o.receipt_state
      FROM vector_ingest_commits c
      JOIN chunk_occurrences o ON o.commit_id = c.id
    `).get()).toEqual({ commit_state: "committed", receipt_state: "committed" });

    const { filterMatchesForCommittedReceipts } = await import("../src/lib/vector-db");
    expect(filterMatchesForCommittedReceipts([{ ...committedRecord, score: 0.9 }])).toHaveLength(1);
    expect(filterMatchesForCommittedReceipts([{
      ...committedRecord,
      metadata: { ...committedRecord.metadata, symbol: "MSFT" },
      score: 0.9
    }])).toEqual([]);
    const markerlessMetadata = Object.fromEntries(
      Object.entries(committedRecord.metadata).filter(([key]) => key !== "receipt_required")
    );
    expect(filterMatchesForCommittedReceipts([{
      ...committedRecord,
      metadata: markerlessMetadata,
      score: 0.9
    }])).toEqual([]);

    // INSERT OR IGNORE must not turn a stale/conflicting prior occurrence into a false completion.
    db.prepare("UPDATE chunk_occurrences SET content_hash = 'stale-conflict'").run();
    const conflicted = await storeDocument(input);
    expect(conflicted).toMatchObject({
      indexed: 1,
      error: "document-receipt-write-failed",
      documentComplete: false
    });
    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it("requires the complete provider vector set before reconciliation can finalize a commit", async () => {
    const {
      beginVectorCommit,
      getDb,
      insertManagedChunkOccurrences,
      markVectorCommitReceiptsPersisted
    } = await import("../src/lib/db");
    const { reconcileManagedVectorRecords } = await import("../src/lib/vector-db");
    const db = getDb();
    const commitId = "vcommit:test:complete-set";
    const source = "fmp-earnings-transcript";
    const accession = "FMP-EARNINGS-TRANSCRIPT:MSFT:2026:Q2:VERSION:test";
    const contentVersion = "content-version-test";
    const tenantScope = "shared:operator";
    beginVectorCommit({
      id: commitId,
      tenantScope,
      userId: "local",
      source,
      accession,
      contentVersion,
      parserRevision: "fmp-transcript-v1",
      embedRevision: "v1",
      expectedVectors: 2,
      now: "2026-07-14T12:00:00.000Z"
    });
    insertManagedChunkOccurrences([1, 2].map((ordinal) => ({
      vectorId: `occ:test:${ordinal}`,
      contentHash: `hash-${ordinal}`,
      symbol: "MSFT",
      source,
      accession,
      section: "body",
      ordinal,
      acceptedAt: "2026-07-14T12:00:00.000Z",
      tenantScope,
      contentVersion,
      commitId,
      receiptState: "pending" as const,
      createdAt: "2026-07-14T12:00:00.000Z"
    })));
    markVectorCommitReceiptsPersisted(commitId, "2026-07-14T12:00:01.000Z");

    const metadata = (ordinal: number) => ({
      source,
      accession,
      symbol: "MSFT",
      vector_commit_id: commitId,
      content_version: contentVersion,
      tenant_scope: tenantScope,
      receipt_required: true,
      ingest_state: "pending",
      chunk_ordinal: ordinal
    });
    mocks.listPaginated.mockResolvedValue({
      vectors: [{ id: "occ:test:1" }],
      pagination: {}
    });
    mocks.fetchRecords.mockResolvedValue({
      records: { "occ:test:1": { id: "occ:test:1", metadata: metadata(1) } }
    });
    expect(await reconcileManagedVectorRecords({ source, dryRun: true })).toEqual({
      dryRun: true,
      promoteIds: [],
      deleteIds: ["occ:test:1"],
      promoted: 0,
      deleted: 0
    });
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commitId))
      .toEqual({ state: "receipts_persisted" });

    mocks.listPaginated.mockResolvedValue({
      vectors: [{ id: "occ:test:1" }, { id: "occ:test:2" }],
      pagination: {}
    });
    mocks.fetchRecords.mockResolvedValue({
      records: {
        "occ:test:1": { id: "occ:test:1", metadata: metadata(1) },
        "occ:test:2": { id: "occ:test:2", metadata: metadata(2) }
      }
    });
    const reconciled = await reconcileManagedVectorRecords({ source, dryRun: false });
    expect(reconciled).toMatchObject({ promoted: 2, deleted: 0 });
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT state FROM vector_ingest_commits WHERE id = ?").get(commitId))
      .toEqual({ state: "committed" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM chunk_occurrences
      WHERE commit_id = ? AND receipt_state = 'committed'
    `).get(commitId)).toEqual({ count: 2 });
  });

  it("records each physical Voyage retry as its own durable provider attempt", async () => {
    const { getDb } = await import("../src/lib/db");
    const { storeDocument } = await import("../src/lib/vector-db");
    const db = getDb();
    db.exec("DELETE FROM provider_usage_outbox; DELETE FROM provider_dispatch_attempts;");
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "1";
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "0";
    mocks.embed
      .mockRejectedValueOnce(Object.assign(new Error("429 synthetic retry"), { status: 429 }))
      .mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] });

    const stored = await storeDocument({
      text: `Unique retry corpus ${randomUUID()} with enough context for one document chunk.`,
      doc_id: `FMP-EARNINGS-TRANSCRIPT:NVDA:2026:Q2:VERSION:${randomUUID()}`,
      ticker: "NVDA",
      title: "NVDA earnings call 2026 Q2",
      doc_type: "earnings-transcript",
      source: "fmp-earnings-transcript",
      published_at: "2026-07-14T12:00:00.000Z"
    });

    expect(stored.documentComplete).toBe(true);
    expect(db.prepare(`
      SELECT status FROM provider_dispatch_attempts
      WHERE provider = 'voyage' AND operation = 'embed document'
      ORDER BY created_at, id
    `).all()).toEqual([{ status: "failed" }, { status: "succeeded" }]);
    expect(db.prepare(`
      SELECT outcome FROM provider_usage_outbox
      WHERE provider = 'voyage' AND operation = 'embed document'
      ORDER BY created_at, id
    `).all()).toEqual([{ outcome: "failed" }, { outcome: "succeeded" }]);
    delete process.env.VECTOR_EMBED_RETRY_ATTEMPTS;
    delete process.env.VECTOR_EMBED_RETRY_DELAY_MS;
  });

  it("uses exact tenant/content/parser identity for stable collision-safe occurrence IDs", async () => {
    const { buildOccurrenceVectorId, vectorTenantScope } = await import("../src/lib/vector-db");
    const base = {
      source: "fmp-earnings-transcript",
      accession: "FMP-EARNINGS-TRANSCRIPT:AAPL:2026:Q1",
      contentVersion: "sha256-v1",
      section: "body",
      ordinal: 1,
      parserRevision: "fmp-transcript-v1",
      embedRevision: "v1"
    };
    const scopeA = vectorTenantScope("user/a");
    const scopeB = vectorTenantScope("user?a");
    expect(scopeA).not.toBe(scopeB);
    const first = buildOccurrenceVectorId({ ...base, tenantScope: scopeA });
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeA })).toBe(first);
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeB })).not.toBe(first);
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeA, contentVersion: "sha256-v2" }))
      .not.toBe(first);
    expect(buildOccurrenceVectorId({ ...base, tenantScope: scopeA, parserRevision: "fmp-transcript-v2" }))
      .not.toBe(first);
  });
});
