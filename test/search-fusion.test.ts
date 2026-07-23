import { describe, it, expect, beforeAll, vi } from "vitest";
import { getDb, applyVersionedMigrations } from "../src/lib/db";
import { retrieveFusedContext } from "../src/lib/rag/search-fusion";
import { insertDocumentChunkFts } from "../src/lib/db-learning";
import { retrieveContextDetailed } from "../src/lib/vector-db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-search-fusion-${randomUUID()}.db`)}`;
  const db = getDb();
  applyVersionedMigrations(db);
});

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    retrieveContextDetailed: vi.fn()
  };
});

describe("Hybrid Search Fusion and MMR Cosine Filtering (P6)", () => {
  it("keeps FTS rows per occurrence (symbol/accession) when content hashes collide", () => {
    const db = getDb();
    // Identical boilerplate (same content hash) in two filings/symbols must keep BOTH lexical
    // rows — retrieval filters by symbol, so a global content-hash delete would silently make
    // the earlier symbol unreachable through FTS.
    insertDocumentChunkFts("sharedhash", "MSFT", "sec-edgar", "acc-msft", "Boilerplate legal text.");
    insertDocumentChunkFts("sharedhash", "GOOG", "sec-edgar", "acc-goog", "Boilerplate legal text.");
    // Re-inserting the SAME occurrence stays idempotent (no duplicate row).
    insertDocumentChunkFts("sharedhash", "GOOG", "sec-edgar", "acc-goog", "Boilerplate legal text.");

    const rows = db.prepare("SELECT symbol, accession FROM document_chunks_fts WHERE content_hash = 'sharedhash' ORDER BY symbol ASC").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe("GOOG");
    expect(rows[1].symbol).toBe("MSFT");
  });

  it("does not call any HTTP embedding endpoint for MMR when no alternative provider is configured", async () => {
    insertDocumentChunkFts(
      "hash-fetch-guard",
      "NVDA",
      "sec-edgar",
      "acc-nvda",
      "NVIDIA data center revenue grew on strong AI accelerator demand."
    );
    vi.mocked(retrieveContextDetailed).mockResolvedValue([]);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const results = await retrieveFusedContext("NVIDIA revenue", "NVDA", 2);
      expect(results.length).toBeGreaterThan(0);
      // Voyage-only deployment: the Jaccard fallback must be chosen up front — never by firing
      // the Voyage credential at a SiliconFlow/OpenRouter endpoint and catching the failure.
      const embeddingCalls = fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes("siliconflow") || String(url).includes("openrouter")
      );
      expect(embeddingCalls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ranks lexical FTS matches by bm25 relevance before RRF", async () => {
    insertDocumentChunkFts(
      "hash-bm25-weak",
      "ORCL",
      "sec-edgar",
      "acc-orcl",
      "The company discusses many topics including one mention of dividends among other items entirely unrelated to payouts."
    );
    insertDocumentChunkFts(
      "hash-bm25-strong",
      "ORCL",
      "sec-edgar",
      "acc-orcl",
      "Dividends dividends dividends: quarterly dividends declared and dividends paid."
    );
    vi.mocked(retrieveContextDetailed).mockResolvedValue([]);

    const results = await retrieveFusedContext("dividends", "ORCL", 2);
    expect(results.length).toBe(2);
    // The bm25-stronger document must receive lexical rank 1 (higher RRF score).
    expect(results[0].text).toContain("quarterly dividends declared");
  });

  it("should retrieve, fuse via RRF, and filter via Jaccard MMR fallback", async () => {
    // Populate SQLite FTS table with lexical chunks
    insertDocumentChunkFts(
      "hash1",
      "AAPL",
      "sec-edgar",
      "acc1",
      "Apple released the iPhone 17 with advanced AI features and a new design."
    );
    insertDocumentChunkFts(
      "hash2",
      "AAPL",
      "sec-edgar",
      "acc1",
      "iPhone sales were strong, but Mac sales declined slightly."
    );
    insertDocumentChunkFts(
      "hash3",
      "AAPL",
      "sec-edgar",
      "acc1",
      "Apple's capital expenditures increased due to data center investments."
    );

    // Mock vector search results (returns hash2 and hash4)
    vi.mocked(retrieveContextDetailed).mockResolvedValueOnce([
      {
        id: "vector2",
        text: "iPhone sales were strong, but Mac sales declined slightly.",
        score: 0.9,
        source: "sec-edgar"
      },
      {
        id: "vector4",
        text: "Strong growth in Apple Services offsets minor hardware declines.",
        score: 0.8,
        source: "sec-edgar"
      }
    ]);

    // Query for "iPhone"
    const results = await retrieveFusedContext("iPhone", "AAPL", 3);

    // Should return results containing the keyword or high similarity
    expect(results).toHaveLength(3);

    // Verify RRF scoring merged them and MMR removed duplicates
    const texts = results.map(r => r.text);
    expect(texts).toContain("Apple released the iPhone 17 with advanced AI features and a new design.");
    expect(texts).toContain("iPhone sales were strong, but Mac sales declined slightly.");
    expect(texts).toContain("Strong growth in Apple Services offsets minor hardware declines.");
  });
});
