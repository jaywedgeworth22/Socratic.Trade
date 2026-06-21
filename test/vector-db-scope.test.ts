import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the scope:'shared'|'private' metadata field added to the RAG layer.
 *
 * The key correctness properties checked here:
 *  1. Shared-tier writes carry scope:'shared'.
 *  2. Private-tier writes carry scope:'private'.
 *  3. The shared-tier query filter uses a Pinecone $or that matches BOTH
 *     scope:'shared' (new vectors) AND userId:'local' (legacy pre-scope vectors).
 *  4. The private-tier query filter still matches by the user's own userId.
 */

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
  setInternalSetting: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  delete process.env.PINECONE_INDEX_NAME;
  delete process.env.VECTOR_EMBED_BATCH_SIZE;
  delete process.env.VECTOR_EMBED_RETRY_ATTEMPTS;
  delete process.env.VECTOR_EMBED_RETRY_DELAY_MS;
  delete process.env.VECTOR_CONTEXT_MAX_CHARS;
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
});

describe("vector-db scope metadata", () => {
  describe("write path — cleanMetadata", () => {
    it("sets scope:'shared' on shared-tier (userId=local) writes", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      const { storeContexts } = await import("../src/lib/vector-db");

      await storeContexts([
        {
          text: "AAPL shared context",
          metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" }
        }
      ]); // default userId = "local" → shared tier

      const records = mocks.upsert.mock.calls[0][0].records;
      expect(records).toHaveLength(1);
      expect(records[0].metadata).toMatchObject({
        userId: "local",
        scope: "shared"
      });
    });

    it("sets scope:'private' on user-private writes", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      const { storeContexts } = await import("../src/lib/vector-db");

      await storeContexts(
        [
          {
            text: "Private AAPL context",
            metadata: { symbol: "AAPL", source: "notes", timestamp: "2026-06-18", accession: "p1" }
          }
        ],
        "user-42"
      );

      const records = mocks.upsert.mock.calls[0][0].records;
      expect(records).toHaveLength(1);
      expect(records[0].metadata).toMatchObject({
        userId: "user-42",
        scope: "private"
      });
    });

    it("does not allow caller metadata to spoof the scope field", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      const { storeContexts } = await import("../src/lib/vector-db");

      await storeContexts(
        [
          {
            text: "Private context with spoofed scope",
            metadata: {
              symbol: "AAPL",
              source: "notes",
              timestamp: "2026-06-18",
              scope: "shared" // attacker tries to promote to shared tier
            }
          }
        ],
        "user-42"
      );

      const records = mocks.upsert.mock.calls[0][0].records;
      expect(records[0].metadata.scope).toBe("private");
      expect(records[0].metadata.userId).toBe("user-42");
    });
  });

  describe("read path — shared-tier query filter (backward-compat $or)", () => {
    it("shared-tier query (userId=local) includes BOTH scope:'shared' AND userId:'local' in filter", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.query.mockResolvedValue({ matches: [] });
      const { retrieveContext } = await import("../src/lib/vector-db");

      await retrieveContext("AAPL catalysts", "AAPL", 3);

      expect(mocks.query).toHaveBeenCalledTimes(1);
      const filter = mocks.query.mock.calls[0][0].filter;
      expect(filter.symbol).toEqual({ $eq: "AAPL" });
      // Must include the $or with both the new scope field AND the legacy userId fallback
      expect(filter.$or).toEqual(
        expect.arrayContaining([
          { scope: { $eq: "shared" } },
          { userId: { $eq: "local" } }
        ])
      );
    });

    it("private-tier query includes the user's own userId filter (not $or)", async () => {
      mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
      mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
      mocks.query.mockResolvedValue({ matches: [] });
      const { retrieveContext } = await import("../src/lib/vector-db");

      await retrieveContext("AAPL catalysts", "AAPL", 3, "user-42");

      // Two queries: one for user-42, one for shared tier
      expect(mocks.query).toHaveBeenCalledTimes(2);

      // First query = user's private docs
      const privateFilter = mocks.query.mock.calls[0][0].filter;
      expect(privateFilter).toMatchObject({
        symbol: { $eq: "AAPL" },
        userId: { $eq: "user-42" }
      });
      expect(privateFilter.$or).toBeUndefined(); // pure userId match, no $or

      // Second query = shared tier (backward-compat $or)
      const sharedFilter = mocks.query.mock.calls[1][0].filter;
      expect(sharedFilter.symbol).toEqual({ $eq: "AAPL" });
      expect(sharedFilter.$or).toEqual(
        expect.arrayContaining([
          { scope: { $eq: "shared" } },
          { userId: { $eq: "local" } }
        ])
      );
    });
  });

  describe("matchToChunk — scope field propagation", () => {
    it("carries scope:'shared' from metadata into RetrievedChunk", async () => {
      const { matchToChunk } = await import("../src/lib/vector-db");
      const chunk = matchToChunk({
        id: "sec-8k:AAPL:a1",
        score: 0.9,
        metadata: { text: "AAPL filing", scope: "shared", userId: "local" }
      });
      expect(chunk.scope).toBe("shared");
    });

    it("carries scope:'private' from metadata into RetrievedChunk", async () => {
      const { matchToChunk } = await import("../src/lib/vector-db");
      const chunk = matchToChunk({
        id: "notes:user-42:p1",
        score: 0.8,
        metadata: { text: "Private AAPL note", scope: "private", userId: "user-42" }
      });
      expect(chunk.scope).toBe("private");
    });

    it("leaves scope undefined for legacy vectors that lack the scope field", async () => {
      const { matchToChunk } = await import("../src/lib/vector-db");
      const chunk = matchToChunk({
        id: "legacy:AAPL:old",
        score: 0.7,
        metadata: { text: "Legacy AAPL context", userId: "local" } // no scope
      });
      expect(chunk.scope).toBeUndefined();
    });

    it("rejects unknown scope values (not 'shared' or 'private')", async () => {
      const { matchToChunk } = await import("../src/lib/vector-db");
      const chunk = matchToChunk({
        id: "x",
        score: 0.5,
        metadata: { text: "test", scope: "admin" } // not a valid VectorScope
      });
      expect(chunk.scope).toBeUndefined();
    });
  });
});
