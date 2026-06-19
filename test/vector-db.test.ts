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
  Pinecone: vi.fn(() => ({
    listIndexes: mocks.listIndexes,
    createIndex: mocks.createIndex,
    Index: mocks.index
  }))
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(() => ({ embed: mocks.embed }))
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey
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
      input: ["AAPL 8-K Item 2.02 details", "MSFT 8-K Item 5.02 details"],
      inputType: "document"
    }));
    const records = mocks.upsert.mock.calls[0][0];
    expect(records).toHaveLength(2);
    expect(records[0].metadata).toMatchObject({ symbol: "AAPL", source: "sec-8k", text: "AAPL 8-K Item 2.02 details", userId: "local" });
  });

  it("honors the configured embedding batch size", async () => {
    process.env.VECTOR_EMBED_BATCH_SIZE = "1";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL context", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" } },
      { text: "MSFT context", metadata: { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18", accession: "m1" } }
    ]);

    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.embed.mock.calls[0][0]).toMatchObject({ input: ["AAPL context"], inputType: "document" });
    expect(mocks.embed.mock.calls[1][0]).toMatchObject({ input: ["MSFT context"], inputType: "document" });
  });

  it("retries Voyage 429s before giving up on a batch", async () => {
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "1";
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "0";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
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

  it("retrieves matching text with query embeddings and symbol/user filters", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "robinhood-agentic" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.query.mockResolvedValue({ matches: [{ metadata: { text: "AAPL retrieved filing context" } }, { metadata: {} }] });
    const { retrieveContext } = await import("../src/lib/vector-db");

    const results = await retrieveContext("AAPL catalysts", "AAPL", 2, "user-1");

    expect(results).toEqual(["AAPL retrieved filing context"]);
    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({ input: ["AAPL catalysts"], inputType: "query" }));
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({
      topK: 2,
      filter: { symbol: "AAPL", userId: "user-1" },
      includeMetadata: true
    }));
  });
});
