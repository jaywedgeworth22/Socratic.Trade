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
