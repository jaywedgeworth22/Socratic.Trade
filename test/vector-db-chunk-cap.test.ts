/**
 * Item 5 (2026-07-01 RAG workstream): align the per-chunk char cap with the token chunker.
 *
 * Before this change, storeContexts unconditionally trimmed every document to
 * DEFAULT_CONTEXT_MAX_CHARS (2400 chars) — including chunks storeDocument already produced via
 * chunkDocument's 480-TOKEN budget, which chunkDocument deliberately keeps atomic (e.g. a table).
 * A near-max-size token-bounded chunk plus its context_header could exceed 2400 chars and get a
 * SECOND, silent truncation with a "[truncated for vector memory]" suffix appended mid-content.
 *
 * storeDocument now computes a cap aligned with the actual chunker token budget
 * (maxTokens * CHARS_PER_TOKEN_CEILING + a header allowance) and passes it to storeContexts via the
 * new StoreContextsOptions.maxChars — so an already-atomic, already-token-bounded chunk round-trips
 * without truncation. Direct storeContexts callers (8-K summaries, disclosures) are unaffected:
 * they never pass maxChars, so they keep the exact default (contextMaxChars(), 2400).
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
    filterNewDocumentChunks: vi.fn(),
    insertDocumentChunks: vi.fn()
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
  audit: vi.fn(),
  setInternalSetting: vi.fn(),
  filterNewDocumentChunks: mocks.filterNewDocumentChunks,
  insertDocumentChunks: mocks.insertDocumentChunks
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  delete process.env.VECTOR_CONTEXT_MAX_CHARS;

  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
  // filterNewDocumentChunks: dedup gate — return every hash as "new" so the chunk isn't skipped.
  mocks.filterNewDocumentChunks.mockImplementation((hashes: Array<{ content_hash: string }>) => hashes);
});

// A single markdown table kept ATOMIC by chunkDocument (tables are never split), long enough in
// CHARS to exceed the OLD fixed 2400-char cap, while staying tiny in TOKENS (chunkDocument's
// whitespace-based counter) because table cells are packed pipe-delimited with no internal
// whitespace — exactly the "long words/table padding" case CHARS_PER_TOKEN_CEILING exists for.
function buildLargeAtomicTableDoc(): string {
  const rows: string[] = ["|Metric|Q1|Q2|Q3|Q4|Q5|Q6|Q7|"];
  for (let i = 0; i < 45; i++) {
    rows.push(`|LineItem${i}|${i * 1111111}|${i * 2222222}|${i * 3333333}|${i * 4444444}|${i * 5555555}|${i * 6666666}|${i * 7777777}|`);
  }
  return rows.join("\n");
}

describe("storeDocument: per-chunk char cap aligned with the token chunker (item 5)", () => {
  it("does not truncate a large atomic (table) chunk that fits the chunker's token budget", async () => {
    const tableText = buildLargeAtomicTableDoc();
    expect(tableText.length).toBeGreaterThan(2400); // would have hit the OLD fixed cap

    const { storeDocument } = await import("../src/lib/vector-db");
    await storeDocument({
      text: tableText,
      ticker: "AAPL",
      title: "AAPL 10-K (2026-06-20)",
      doc_type: "10-k",
      source: "sec-edgar",
      published_at: "2026-06-20"
    });

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    const embeddedTexts: string[] = mocks.embed.mock.calls[0][0].input;
    expect(embeddedTexts.length).toBeGreaterThan(0);
    for (const text of embeddedTexts) {
      expect(text).not.toContain("[truncated for vector memory]");
    }
  });

  it("still applies the default 2400-char cap for a DIRECT storeContexts caller (8-K summaries) — unaffected by the storeDocument alignment", async () => {
    const longSummary = "AAPL 8-K catalyst filing. ".repeat(150); // well over 2400 chars, not chunked
    expect(longSummary.length).toBeGreaterThan(2400);

    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([
      { text: longSummary, metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);

    const embeddedTexts: string[] = mocks.embed.mock.calls[0][0].input;
    expect(embeddedTexts[0]).toContain("[truncated for vector memory]");
  });

  // C5 expert-review correction: is_table chunks are EXEMPT from trimming entirely (not just given
  // a bigger cap) — a table so large it would exceed even the token-aligned cap must still round-trip
  // whole, because truncating mid-row corrupts numeric data. Verified directly via storeContexts with
  // metadata.is_table=true (the same metadata storeDocument attaches for table chunks).
  it("never trims an is_table=true document, even one far larger than the token-aligned cap", async () => {
    // Build a table intentionally larger than storeDocument's own aligned cap (480*8+512=4352 chars)
    // to prove the exemption is unconditional, not just "a bigger number".
    const rows: string[] = ["|Metric|Q1|Q2|Q3|Q4|Q5|Q6|Q7|Q8|Q9|Q10|"];
    for (let i = 0; i < 200; i++) {
      rows.push(`|LineItem${i}|${i * 1111111}|${i * 2222222}|${i * 3333333}|${i * 4444444}|${i * 5555555}|${i * 6666666}|${i * 7777777}|${i * 8888888}|${i * 9999999}|${i}|`);
    }
    const hugeTable = rows.join("\n");
    expect(hugeTable.length).toBeGreaterThan(4352);

    const { storeContexts } = await import("../src/lib/vector-db");
    await storeContexts([
      { text: hugeTable, metadata: { symbol: "AAPL", source: "sec-edgar", timestamp: "2026-06-20", is_table: true } }
    ], "local", { maxChars: 2400 }); // even with an explicit small maxChars, is_table must win

    const embeddedTexts: string[] = mocks.embed.mock.calls[0][0].input;
    expect(embeddedTexts[0]).not.toContain("[truncated for vector memory]");
    // The full table content (last row) must be present untouched.
    expect(embeddedTexts[0]).toContain("|LineItem199|");
  });

  it("content_hash (computed pre-trim by chunkDocument) stays consistent with the stored text for a table chunk", async () => {
    const { hashContent } = await import("../src/lib/rag/chunk");
    const tableText = buildLargeAtomicTableDoc();

    const { storeDocument } = await import("../src/lib/vector-db");
    await storeDocument({
      text: tableText,
      ticker: "AAPL",
      title: "AAPL 10-K (2026-06-20)",
      doc_type: "10-k",
      source: "sec-edgar",
      published_at: "2026-06-20"
    });

    // filterNewDocumentChunks receives the pre-trim content_hash computed by chunkDocument.
    const hashesPassed = mocks.filterNewDocumentChunks.mock.calls[0][0] as Array<{ content_hash: string }>;
    expect(hashesPassed.length).toBeGreaterThan(0);
    // Since the chunk is a table (is_table=true), it is never trimmed downstream — so the hash of
    // the RAW table text (as chunkDocument produced it, pre-header) still matches what's embedded
    // modulo the context_header prefix. Confirm no truncation marker snuck in either way.
    const embeddedTexts: string[] = mocks.embed.mock.calls[0][0].input;
    for (const text of embeddedTexts) {
      expect(text).not.toContain("[truncated for vector memory]");
    }
    expect(hashesPassed[0]!.content_hash).toBe(hashContent(tableText));
  });
});
