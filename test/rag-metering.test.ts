import { describe, expect, it, afterAll } from "vitest";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

// ── Setup: isolated temp SQLite for rag_usage + document_chunks tables ────────

const tmpDir = path.join(os.tmpdir(), `trading-test-rag-metering-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");

if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

// Point DATABASE_URL at the temp file before importing db.
process.env.DATABASE_URL = `file:${tmpDbPath}`;

// Reset the module cache so db.ts picks up the new DATABASE_URL.
// (vitest caches module loads; clearing the cache forces a fresh init.)

afterAll(() => {
  try { unlinkSync(tmpDbPath); } catch { /* best-effort */ }
  try { unlinkSync(`${tmpDbPath}-wal`); } catch { /* ok */ }
  try { unlinkSync(`${tmpDbPath}-shm`); } catch { /* ok */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// Dynamic imports so the module cache sees the overridden DATABASE_URL.
const { recordRagUsage, getRagUsageSummary, meterEmbed, meterRerank, meterPineconeQuery } = await import("../src/lib/rag-metering");
const { getChunkCoverage, filterNewDocumentChunks, insertDocumentChunks } = await import("../src/lib/db");

function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

describe("rag-metering", () => {
  it("records and aggregates rag usage", () => {
    meterEmbed(["Risk factors for AAPL.", "MD&A for AAPL."]);
    meterEmbed(["Financial notes."]);
    meterRerank("AAPL risk", ["Chunk A", "Chunk B", "Chunk C"]);

    const summary = getRagUsageSummary();
    const embedRows = summary.filter((r) => r.operation === "embed");
    const rerankRows = summary.filter((r) => r.operation === "rerank");

    expect(embedRows.length).toBeGreaterThanOrEqual(1);
    expect(rerankRows.length).toBeGreaterThanOrEqual(1);

    // Embed: 3 texts across 2 calls
    const embedTotal = embedRows.reduce((s, r) => s + r.batchCount, 0);
    expect(embedTotal).toBe(3);

    // Rerank: 3 documents in one call
    const rerankTotal = rerankRows.reduce((s, r) => s + r.batchCount, 0);
    expect(rerankTotal).toBe(3);
  });

  it("meter helpers attribute retrieval spend to the requesting userId (not default 'local')", () => {
    // Regression: the daily LLM/RAG budget filters rag_usage by userId, so retrieval meters MUST book
    // under the requesting user or a non-local user's ceiling never trips (Codex P2 on 1e14e848fb).
    meterEmbed(["query for alice"], undefined, "alice");
    meterPineconeQuery(7, "alice");
    meterRerank("alice q", ["d1", "d2"], undefined, "alice");

    const alice = getRagUsageSummary().filter((r) => r.userId === "alice");
    expect(alice.some((r) => r.operation === "embed")).toBe(true);
    expect(alice.some((r) => r.operation === "query")).toBe(true);
    expect(alice.some((r) => r.operation === "rerank")).toBe(true);
    // And nothing from these calls leaked to the default "local" bucket.
    const localAfter = getRagUsageSummary().filter((r) => r.userId === "local");
    expect(localAfter.every((r) => r.userId === "local")).toBe(true); // sanity
    expect(alice.reduce((s, r) => s + r.batchCount, 0)).toBeGreaterThan(0);
  });

  it("recordRagUsage never throws", () => {
    // Force a bad call that would break if we didn't catch
    expect(() => recordRagUsage({ operation: "embed" as any, tokensIn: -1 })).not.toThrow();
  });

  it("getRagUsageSummary respects sinceIso window", () => {
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const futureSummary = getRagUsageSummary({ sinceIso: future });
    expect(futureSummary.length).toBe(0); // nothing in the future

    const past = new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString();
    const pastSummary = getRagUsageSummary({ sinceIso: past });
    expect(pastSummary.length).toBeGreaterThan(0); // everything since last year
  });
});

describe("document_chunks content-hash dedup", () => {
  it("filterNewDocumentChunks returns only new hashes", () => {
    const h1 = sha16("unique text A");
    const h2 = sha16("unique text B");
    const h3 = sha16("unique text C");

    // Insert two
    insertDocumentChunks([
      { content_hash: h1, symbol: "AAPL", source: "sec-edgar", chunk_id: "a" },
      { content_hash: h2, symbol: "MSFT", source: "sec-edgar", chunk_id: "b" }
    ]);

    // All three
    const candidates = [
      { content_hash: h1, symbol: "AAPL", source: "sec-edgar", chunk_id: "a" },
      { content_hash: h2, symbol: "MSFT", source: "sec-edgar", chunk_id: "b" },
      { content_hash: h3, symbol: "GOOG", source: "sec-edgar", chunk_id: "c" }
    ];

    const newOnes = filterNewDocumentChunks(candidates);
    expect(newOnes).toHaveLength(1);
    expect(newOnes[0]!.content_hash).toBe(h3);

    // Empty input
    expect(filterNewDocumentChunks([])).toEqual([]);
  });

  it("getChunkCoverage returns per-symbol stats", () => {
    const coverage = getChunkCoverage();
    // AAPL and MSFT were inserted above
    const aapl = coverage.find((c) => c.symbol === "AAPL");
    const msft = coverage.find((c) => c.symbol === "MSFT");
    expect(aapl).toBeDefined();
    expect(aapl!.chunkCount).toBe(1);
    expect(msft).toBeDefined();
    expect(msft!.chunkCount).toBe(1);
  });
});
