/**
 * DeepInfra/bge-m3 sums the whole embed `input[]` against 8192.  Live VECTOR_EMBED_BATCH_SIZE=32
 * sent 8193 tokens in one POST and 400'd rag-embed.  These tests pin token-budget packing and
 * isolate-and-chunk of a single over-limit text so those documents still land.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBED_MODEL_CONTEXT_TOKENS,
  EMBED_REQUEST_BYTE_BUDGET,
  EMBED_REQUEST_TOKEN_BUDGET,
  embedRequestFits,
  embedTextTokenEstimate,
  packInWindowTexts,
  splitTextToEmbedWindow
} from "../src/lib/rag/embed-request-pack";
import { approxTokens } from "../src/lib/rag-metering";

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
    describeIndex: vi.fn(),
    embed: vi.fn(),
    resolveApiKey: vi.fn(),
    audit: vi.fn()
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

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: mocks.audit,
  setInternalSetting: vi.fn()
}));

const LIVE_400_BODY =
  "Embedding API failed (isOpenRouter=true): 400 This model's maximum context length is 8192 tokens. However, you requested 0 output tokens and your prompt contains at least 8193 input tokens, for a total of at least 8193 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=8193)";

function textOfTokens(tokens: number, char = "A"): string {
  return char.repeat(tokens * 4);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.VECTOR_EMBED_BATCH_SIZE = "32";
  delete process.env.VECTOR_CONTEXT_MAX_CHARS;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.embed.mockImplementation(async ({ input }: { input: string[] }) => {
    const tokens = approxTokens(input);
    if (tokens >= EMBED_MODEL_CONTEXT_TOKENS || !embedRequestFits(input)) {
      throw new Error(LIVE_400_BODY);
    }
    return {
      data: input.map((_, i) => ({ embedding: [0.1 + i * 0.001, 0.2, 0.3] }))
    };
  });
});

describe("embed request packer (pure)", () => {
  it("uses the rag-metering approxTokens estimator", () => {
    const sample = textOfTokens(256);
    expect(embedTextTokenEstimate(sample)).toBe(256);
    expect(approxTokens([sample])).toBe(256);
  });

  it("packs a 32-text batch that summed to 8192 so no request reaches 8193", () => {
    const items = Array.from({ length: 32 }, (_, sourceIndex) => ({
      text: textOfTokens(256),
      sourceIndex
    }));
    expect(approxTokens(items.map((item) => item.text))).toBe(8192);

    const groups = packInWindowTexts(items, { maxCount: 32 });
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.some((group) => group.length === 32)).toBe(false);

    let covered = 0;
    for (const group of groups) {
      const texts = group.map((item) => item.text);
      expect(approxTokens(texts)).toBeLessThanOrEqual(EMBED_REQUEST_TOKEN_BUDGET);
      expect(embedRequestFits(texts)).toBe(true);
      covered += group.length;
    }
    expect(covered).toBe(32);
  });

  it("does not treat VECTOR_EMBED_BATCH_SIZE=32 as the send size when tokens would overflow", () => {
    const items = Array.from({ length: 32 }, (_, sourceIndex) => ({
      text: textOfTokens(256),
      sourceIndex
    }));
    const groups = packInWindowTexts(items, { maxCount: 32 });
    for (const group of groups) {
      expect(group.length).toBeLessThan(32);
      expect(approxTokens(group.map((item) => item.text))).toBeLessThan(EMBED_MODEL_CONTEXT_TOKENS);
    }
  });

  it("chunks a single >8192-token text into in-window pieces", () => {
    const giant = textOfTokens(9000, "B");
    expect(embedTextTokenEstimate(giant)).toBeGreaterThan(EMBED_MODEL_CONTEXT_TOKENS);

    const pieces = splitTextToEmbedWindow(giant);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(giant);
    for (const piece of pieces) {
      expect(embedRequestFits([piece])).toBe(true);
      expect(embedTextTokenEstimate(piece)).toBeLessThanOrEqual(EMBED_REQUEST_TOKEN_BUDGET);
      expect(Buffer.byteLength(piece, "utf8")).toBeLessThanOrEqual(EMBED_REQUEST_BYTE_BUDGET);
    }
  });

  it("leaves a 2400-char VECTOR_CONTEXT_MAX_CHARS text unsplit", () => {
    const trimmed = "x".repeat(2400);
    expect(splitTextToEmbedWindow(trimmed)).toEqual([trimmed]);
    expect(embedRequestFits([trimmed])).toBe(true);
  });
});

describe("storeContexts embed window (ingest)", () => {
  it("embeds a 32-count batch as in-window pieces, not one 8193-token 400", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const documents = Array.from({ length: 32 }, (_, i) => ({
      text: textOfTokens(256, "C"),
      metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-08-18", accession: `batch-${i}` }
    }));

    const result = await storeContexts(documents);

    expect(result.indexed).toBe(32);
    expect(result.rejectedInvalidEmbeddings ?? 0).toBe(0);
    expect(mocks.embed.mock.calls.length).toBeGreaterThan(1);
    for (const call of mocks.embed.mock.calls) {
      const input = call[0].input as string[];
      expect(input.length).toBeLessThan(32);
      expect(approxTokens(input)).toBeLessThanOrEqual(EMBED_REQUEST_TOKEN_BUDGET);
      expect(approxTokens(input)).toBeLessThan(EMBED_MODEL_CONTEXT_TOKENS);
      expect(embedRequestFits(input)).toBe(true);
    }
    expect(mocks.upsert).toHaveBeenCalled();
    const thrown400 = mocks.embed.mock.results.some((entry) => (
      entry.type === "throw" && String(entry.value).includes("value=8193")
    ));
    expect(thrown400).toBe(false);
  });

  it("chunks a single over-window table and still indexes it with the rest of the batch", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const giant = textOfTokens(9000, "D");
    const result = await storeContexts([
      {
        text: giant,
        metadata: {
          symbol: "AAPL",
          source: "sec-10k",
          timestamp: "2026-08-18",
          accession: "giant-table",
          is_table: true
        }
      },
      {
        text: "small companion filing",
        metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-08-18", accession: "small" }
      }
    ]);

    expect(result.indexed).toBe(2);
    expect(result.rejectedInvalidEmbeddings ?? 0).toBe(0);
    expect(mocks.embed.mock.calls.length).toBeGreaterThan(1);
    for (const call of mocks.embed.mock.calls) {
      const input = call[0].input as string[];
      expect(approxTokens(input)).toBeLessThan(EMBED_MODEL_CONTEXT_TOKENS);
      expect(embedRequestFits(input)).toBe(true);
      for (const text of input) {
        expect(embedTextTokenEstimate(text)).toBeLessThanOrEqual(EMBED_REQUEST_TOKEN_BUDGET);
      }
    }
    const thrown400 = mocks.embed.mock.results.some((entry) => (
      entry.type === "throw" && String(entry.value).includes("input_tokens")
    ));
    expect(thrown400).toBe(false);
    expect(mocks.upsert).toHaveBeenCalled();
  });
});

describe("query embed window", () => {
  it("does not send a single over-window query as one 400", async () => {
    mocks.query.mockResolvedValue({
      matches: [{ id: "a", score: 0.9, metadata: { text: "hello", userId: "local", scope: "shared" } }]
    });
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed(textOfTokens(9000, "Q"), "AAPL", 3, "local");
    expect(chunks.map((chunk) => chunk.id)).toEqual(["a"]);
    expect(mocks.embed).toHaveBeenCalled();
    for (const call of mocks.embed.mock.calls) {
      const input = call[0].input as string[];
      expect(approxTokens(input)).toBeLessThan(EMBED_MODEL_CONTEXT_TOKENS);
      expect(embedRequestFits(input)).toBe(true);
    }
    const thrown400 = mocks.embed.mock.results.some((entry) => (
      entry.type === "throw" && String(entry.value).includes("value=8193")
    ));
    expect(thrown400).toBe(false);
  });
});
