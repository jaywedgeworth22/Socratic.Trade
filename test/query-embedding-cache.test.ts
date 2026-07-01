// G8(b) — query-embedding LRU cache around the single-query embed call in retrieveContextDetailed.
// Mirrors the mocking pattern in test/vector-db.test.ts (Pinecone/Voyage/db mocked at module level).
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
  setInternalSetting: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  delete process.env.PINECONE_INDEX_NAME;
  delete process.env.VECTOR_QUERY_EMBED_CACHE;
  delete process.env.VECTOR_QUERY_EMBED_CACHE_SIZE;
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
  mocks.query.mockResolvedValue({ matches: [{ metadata: { text: "AAPL retrieved filing context" } }] });
});

describe("query-embedding LRU cache (G8b)", () => {
  it("does not call embed a second time for an identical repeated query (default: cache on)", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL guidance catalysts", "AAPL", 2, "local");
    await retrieveContextDetailed("AAPL guidance catalysts", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    // Pinecone is still queried each time — only the embed call is cached.
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("normalizes whitespace/casing so near-identical queries still hit the cache", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL Guidance", "AAPL", 2, "local");
    await retrieveContextDetailed("  aapl   guidance  ", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(1);
  });

  it("calls embed again for a genuinely different query", async () => {
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL guidance", "AAPL", 2, "local");
    await retrieveContextDetailed("AAPL insider selling", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache document/upsert embeddings — only the query path", async () => {
    const { storeContext, retrieveContextDetailed } = await import("../src/lib/vector-db");
    mocks.listIndexes.mockResolvedValue({ indexes: [] });
    mocks.createIndex.mockResolvedValue(undefined);

    await storeContext("AAPL guidance", { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" });
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
    await retrieveContextDetailed("AAPL guidance", "AAPL", 2, "local");

    // Document embed (storeContext) + query embed (retrieveContextDetailed) — the shared normalized
    // text does not collapse them because caching only wraps the query-inputType call site.
    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.embed.mock.calls[0][0]).toMatchObject({ inputType: "document" });
    expect(mocks.embed.mock.calls[1][0]).toMatchObject({ inputType: "query" });
  });

  it("can be disabled via VECTOR_QUERY_EMBED_CACHE=off, restoring one embed call per retrieval", async () => {
    process.env.VECTOR_QUERY_EMBED_CACHE = "off";
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("AAPL guidance", "AAPL", 2, "local");
    await retrieveContextDetailed("AAPL guidance", "AAPL", 2, "local");

    expect(mocks.embed).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used entry once VECTOR_QUERY_EMBED_CACHE_SIZE is exceeded", async () => {
    process.env.VECTOR_QUERY_EMBED_CACHE_SIZE = "1";
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");

    await retrieveContextDetailed("query one", "AAPL", 2, "local"); // embed #1, cached
    await retrieveContextDetailed("query two", "AAPL", 2, "local"); // embed #2, evicts "query one"
    await retrieveContextDetailed("query one", "AAPL", 2, "local"); // evicted -> embed #3

    expect(mocks.embed).toHaveBeenCalledTimes(3);
  });

  it("normalizeQueryCacheKey lowercases and collapses whitespace", async () => {
    const { normalizeQueryCacheKey } = await import("../src/lib/vector-db");
    expect(normalizeQueryCacheKey("  AAPL   Guidance ")).toBe("aapl guidance");
    expect(normalizeQueryCacheKey("aapl guidance")).toBe("aapl guidance");
  });
});
