import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const query = vi.fn();
  const index = vi.fn(() => ({ upsert, query }));
  return {
    upsert,
    query,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    embed: vi.fn(),
    resolveApiKey: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
    listIndexes: mocks.listIndexes,
    createIndex: mocks.createIndex,
    Index: mocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: vi.fn(),
  setInternalSetting: vi.fn(),
  filterNewDocumentChunks: vi.fn((chunks) => chunks),
  insertDocumentChunks: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  delete process.env.PINECONE_INDEX_NAME;
  delete process.env.VECTOR_EMBED_BATCH_SIZE;
  delete process.env.VECTOR_EMBED_BATCH_DELAY_MS;
  delete process.env.VECTOR_EMBED_RETRY_ATTEMPTS;
  delete process.env.VECTOR_EMBED_RETRY_DELAY_MS;
  delete process.env.VECTOR_CONTEXT_MAX_CHARS;
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
});

describe("vector-db", () => {
  it("batches document embeddings and upserts through one initialized index", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [] });
    mocks.createIndex.mockResolvedValue(undefined);
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL 8-K Item 2.02 details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" } },
      { text: "MSFT 8-K Item 5.02 details", metadata: { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18", accession: "m1" } }
    ]);

    expect(mocks.listIndexes).toHaveBeenCalledTimes(1);
    expect(mocks.createIndex).toHaveBeenCalledTimes(1);
    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({
      model: "voyage-finance-2",
      input: [
        "[Published: 2026-06-18] AAPL 8-K Item 2.02 details",
        "[Published: 2026-06-18] MSFT 8-K Item 5.02 details"
      ],
      inputType: "document"
    }));
    // Pinecone SDK v8 takes an options object: index.upsert({ records }).
    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records).toHaveLength(2);
    expect(records[0].metadata).toMatchObject({
      symbol: "AAPL",
      source: "sec-8k",
      text: "[Published: 2026-06-18] AAPL 8-K Item 2.02 details",
      userId: "local"
    });
  });

  it("does not let document metadata spoof reserved tenant or text fields", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      {
        text: "Private AAPL context",
        metadata: {
          symbol: "AAPL",
          source: "notes",
          timestamp: "2026-06-20",
          userId: "attacker",
          text: "spoofed body"
        }
      }
    ], "user-1");

    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records[0].metadata).toMatchObject({
      symbol: "AAPL",
      source: "notes",
      text: "[Published: 2026-06-20] Private AAPL context",
      userId: "user-1"
    });
  });

  // Item 6 (2026-07-01 RAG workstream): doc_type is now normalized to lowercase AT WRITE TIME
  // (cleanMetadata) regardless of what casing the caller passes in — some ingesters historically
  // passed "10-K"/"10-Q" (upper), others "8-k" (lower). buildExtraFilters still expands both
  // casings at query time so pre-existing mixed-case vectors stay matchable (see
  // test/vector-db-retrieval.test.ts "matches doc_type across casings").
  it("normalizes doc_type to lowercase at write time regardless of caller casing", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL 10-K body", metadata: { symbol: "AAPL", source: "sec-edgar", timestamp: "2026-06-20", doc_type: "10-K" } },
      { text: "AAPL 8-K catalyst", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20", doc_type: "8-k" } }
    ]);

    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records[0].metadata.doc_type).toBe("10-k");
    expect(records[1].metadata.doc_type).toBe("8-k"); // already-lowercase input is unaffected
  });

  it("leaves other metadata fields' casing untouched (only doc_type is normalized)", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL 10-K body", metadata: { symbol: "AAPL", source: "SEC-EDGAR", timestamp: "2026-06-20", doc_type: "10-K", section: "Risk Factors" } }
    ]);

    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records[0].metadata.doc_type).toBe("10-k");
    expect(records[0].metadata.source).toBe("SEC-EDGAR"); // unrelated field: casing untouched
    expect(records[0].metadata.section).toBe("Risk Factors"); // unrelated field: casing untouched
  });

  it("honors the configured embedding batch size", async () => {
    process.env.VECTOR_EMBED_BATCH_SIZE = "1";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL context", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" } },
      { text: "MSFT context", metadata: { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18", accession: "m1" } }
    ]);

    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.embed.mock.calls[0][0]).toMatchObject({ input: ["[Published: 2026-06-18] AAPL context"], inputType: "document" });
    expect(mocks.embed.mock.calls[1][0]).toMatchObject({ input: ["[Published: 2026-06-18] MSFT context"], inputType: "document" });
  });

  it("retries Voyage 429s before giving up on a batch", async () => {
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "1";
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "0";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed
      .mockRejectedValueOnce(Object.assign(new Error("Status code: 429 Rate Limit Exceeded"), { status: 429 }))
      .mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL context", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" } }
    ]);

    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("shares index initialization across concurrent single-document stores", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [] });
    mocks.createIndex.mockResolvedValue(undefined);
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContext } = await import("../src/lib/vector-db");

    await Promise.all([
      storeContext("AAPL context", { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" }),
      storeContext("MSFT context", { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18", accession: "m1" })
    ]);

    expect(mocks.listIndexes).toHaveBeenCalledTimes(1);
    expect(mocks.createIndex).toHaveBeenCalledTimes(1);
  });

  it("retrieves matching text with query embeddings and tenant-safe public/user filters", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.query.mockResolvedValue({ matches: [{ metadata: { text: "AAPL retrieved filing context" } }, { metadata: {} }] });
    const { retrieveContext } = await import("../src/lib/vector-db");

    const results = await retrieveContext("AAPL catalysts", "AAPL", 2, "user-1");

    expect(results).toEqual(["AAPL retrieved filing context"]);
    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({ input: ["AAPL catalysts"], inputType: "query" }));
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0][0]).toMatchObject({
      // Reranking is on by default, so Pinecone over-fetches (overFetchK(2)=10) and Voyage reranks
      // back down to the requested limit. The filter is the tenant-isolation contract under test.
      topK: 10,
      filter: {
        symbol: { $eq: "AAPL" },
        userId: { $eq: "user-1" }
      },
      includeMetadata: true
    });
    // The shared-tier query now uses a backward-compat $or: scope:'shared' OR userId:'local'
    // so that pre-scope (legacy) vectors are still retrieved.
    const sharedFilter = mocks.query.mock.calls[1][0].filter;
    expect(sharedFilter.symbol).toEqual({ $eq: "AAPL" });
    expect(sharedFilter.$or).toEqual(
      expect.arrayContaining([
        { scope: { $eq: "shared" } },
        { userId: { $eq: "local" } }
      ])
    );
  });

  it("sanitizes user IDs correctly", async () => {
    const { sanitizeUserId } = await import("../src/lib/vector-db");
    expect(sanitizeUserId("user; DROP TABLE users;")).toBe("userDROPTABLEusers");
    expect(sanitizeUserId("test-user_123.dots@domain.com")).toBe("test-user_123.dots@domain.com");
    expect(sanitizeUserId("a".repeat(150))).toBe("a".repeat(100));
    expect(sanitizeUserId("")).toBe("local");
    expect(sanitizeUserId(undefined)).toBe("local");
    expect(sanitizeUserId("!!!")).toBe("local");
  });

  it("uses raw user IDs for key lookup and sanitized user IDs for Pinecone filters", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.query.mockResolvedValue({ matches: [] });
    const { retrieveContext } = await import("../src/lib/vector-db");

    await retrieveContext("query", "AAPL", 2, "auth0|user 1");

    expect(mocks.resolveApiKey).toHaveBeenCalledWith("pinecone", "auth0|user 1");
    expect(mocks.resolveApiKey).toHaveBeenCalledWith("voyage", "auth0|user 1");
    expect(mocks.query.mock.calls[0][0].filter.userId).toEqual({ $eq: "auth0user1" });
  });

  it("applies deduplication, score sorting, and slicing in retrieveContext", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    
    // First query returns records with IDs and scores
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.9, metadata: { text: "High score user doc" } },
        { id: "doc-2", score: 0.7, metadata: { text: "Medium score user doc" } }
      ]
    });
    // Second query (public "local") returns overlapping ID with lower score, and a new public doc
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.8, metadata: { text: "High score user doc duplicate" } },
        { id: "doc-3", score: 0.95, metadata: { text: "Very high score public doc" } }
      ]
    });

    const { retrieveContext } = await import("../src/lib/vector-db");
    const results = await retrieveContext("query", "AAPL", 2, "user-1");

    // Total top 2 should be doc-3 (0.95) and doc-1 (0.9, deduplicated)
    expect(results).toEqual(["Very high score public doc", "High score user doc"]);
  });

  it("Voyage Backoff Jitter Test: verifies exponential backoff with full jitter is distributed", async () => {
    const { retryAfterMs } = await import("../src/lib/vector-db");
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "20000";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";

    const error = new Error("429 Rate Limit");
    const sampleSize = 100;
    const delays: number[] = [];

    for (let i = 0; i < sampleSize; i++) {
      delays.push(retryAfterMs(error, 2));
    }

    // attempt = 2, baseDelay = 20s => max backoff = min(60s, 20s * 2^2) = 60s = 60,000ms
    // delay should be between 0 and 60,000.
    const minDelay = Math.min(...delays);
    const maxDelay = Math.max(...delays);

    expect(minDelay).toBeGreaterThanOrEqual(0);
    expect(maxDelay).toBeLessThanOrEqual(60000);
    
    // Check that we have a wide distribution (at least 20 seconds difference between min and max)
    expect(maxDelay - minDelay).toBeGreaterThan(20000);
  });

  it("prepends publication date for string, number, and Date object timestamps", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    // Test ISO string
    await storeContexts([
      { text: "AAPL document", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20T18:00:16Z" } }
    ]);
    expect(mocks.embed.mock.calls[mocks.embed.mock.calls.length - 1][0].input[0]).toBe("[Published: 2026-06-20] AAPL document");

    // Test Epoch Milliseconds Number
    const epochTime = new Date("2026-06-19T12:00:00Z").getTime();
    await storeContexts([
      { text: "AAPL document 2", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: epochTime as any } }
    ]);
    expect(mocks.embed.mock.calls[mocks.embed.mock.calls.length - 1][0].input[0]).toBe("[Published: 2026-06-19] AAPL document 2");

    // Test Date Object
    const dateObj = new Date("2026-06-18T00:00:00Z");
    await storeContexts([
      { text: "AAPL document 3", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: dateObj as any } }
    ]);
    expect(mocks.embed.mock.calls[mocks.embed.mock.calls.length - 1][0].input[0]).toBe("[Published: 2026-06-18] AAPL document 3");
  });
});
