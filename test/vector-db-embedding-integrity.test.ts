/**
 * R2 (2026-07-01 expert review): embedding integrity guard, always-on (no flag). Rejects a
 * malformed embedding (non-array, empty, or containing a non-finite value like NaN/Infinity)
 * instead of upserting a degenerate vector or returning garbage query matches. Never throws — a
 * single bad embedding in a batch is dropped+audited, not fatal to the whole batch.
 */
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
    resolveApiKey: vi.fn(),
    audit: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return { listIndexes: mocks.listIndexes, createIndex: mocks.createIndex, Index: mocks.index };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: mocks.audit,
  setInternalSetting: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
});

describe("isValidEmbedding (pure predicate)", () => {
  it("accepts a non-empty array of finite numbers", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding([0.1, 0.2, 0.3])).toBe(true);
  });
  it("rejects a non-array", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding(undefined)).toBe(false);
    expect(isValidEmbedding(null)).toBe(false);
    expect(isValidEmbedding("not an array")).toBe(false);
  });
  it("rejects an empty array", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding([])).toBe(false);
  });
  it("rejects an array containing NaN or Infinity", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding([0.1, NaN, 0.3])).toBe(false);
    expect(isValidEmbedding([0.1, Infinity, 0.3])).toBe(false);
    expect(isValidEmbedding([0.1, -Infinity, 0.3])).toBe(false);
  });
  it("rejects an array containing a non-number", async () => {
    const { isValidEmbedding } = await import("../src/lib/vector-db");
    expect(isValidEmbedding([0.1, "0.2" as any, 0.3])).toBe(false);
  });
});

describe("storeContexts: drops a malformed embedding instead of upserting it (never throws)", () => {
  it("skips a NaN-poisoned document, still upserts the healthy ones in the same batch, and reports the rejection count", async () => {
    mocks.embed.mockResolvedValue({
      data: [
        { embedding: [0.1, 0.2] }, // healthy
        { embedding: [0.1, NaN] }, // poisoned — must be rejected, not upserted
        { embedding: [0.3, 0.4] } // healthy
      ]
    });

    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([
      { text: "AAPL doc 1", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } },
      { text: "AAPL doc 2 (will be poisoned)", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } },
      { text: "AAPL doc 3", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);

    expect(result.indexed).toBe(2);
    expect(result.rejectedInvalidEmbeddings).toBe(1);
    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records).toHaveLength(2);
    expect(mocks.audit).toHaveBeenCalledWith("vector_embedding_integrity", expect.objectContaining({ rejected: 1 }), "local");
  });

  it("does not report a rejection count when every embedding is healthy (byte-for-byte unaffected)", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");
    const result = await storeContexts([
      { text: "AAPL doc", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);
    expect(result.indexed).toBe(1);
    expect(result.rejectedInvalidEmbeddings).toBeUndefined();
  });
});

describe("retrieveContextDetailed: a malformed query embedding returns an empty result, not garbage matches", () => {
  it("returns [] and audits when Voyage returns a NaN-poisoned query embedding", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [NaN, NaN] }] });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local");
    expect(chunks).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled(); // never even reaches Pinecone with a bad vector
    expect(mocks.audit).toHaveBeenCalledWith("vector_embedding_integrity", expect.objectContaining({ rejected: 1 }), "local");
  });

  it("proceeds normally with a healthy query embedding (byte-for-byte unaffected)", async () => {
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.query.mockResolvedValue({ matches: [{ id: "a", score: 0.9, metadata: { text: "hello" } }] });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("query", "AAPL", 3, "local");
    expect(chunks.map((c) => c.id)).toEqual(["a"]);
  });
});
