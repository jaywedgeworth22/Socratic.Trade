/**
 * R13 (2026-07-01 RAG backlog): provenance-complete citations + optional staleness label,
 * wired into orchestrator.buildProductionDeps().searchKnowledge — BACKEND/PAYLOAD ONLY.
 *
 * Verifies the additive doc_type/section keys are always forwarded, and isStale is included
 * ONLY when RAG_CITATION_STALENESS is on (advisory-only, never gates retrieval).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ retrieveContextDetailed: vi.fn() }));

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return { ...actual, retrieveContextDetailed: mocks.retrieveContextDetailed };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-orch-search-knowledge-${randomUUID()}.db`)}`;
});

describe("buildProductionDeps().searchKnowledge — R13 provenance payload", () => {
  beforeEach(() => {
    mocks.retrieveContextDetailed.mockReset();
    delete process.env.RAG_CITATION_STALENESS;
  });

  it("returns doc_type/section as additive keys, and NO isStale key when the flag is off", async () => {
    mocks.retrieveContextDetailed.mockResolvedValue([
      {
        id: "AAPL-10K#c001",
        text: "Apple faces supply-chain risk.",
        score: 0.8,
        source: "sec-edgar",
        as_of: "2024-01-15",
        doc_type: "10-k",
        section: "risk_factors",
        url: "https://sec.gov/x"
      }
    ]);
    const { buildProductionDeps } = await import("../src/lib/chat/orchestrator");
    const deps = buildProductionDeps();

    const results = await deps.searchKnowledge({ query: "supply chain risk", ticker: "AAPL" }, "local");

    expect(results).toHaveLength(1);
    const chunk = results[0]!;
    expect(chunk.chunk_id).toBe("AAPL-10K#c001");
    expect(chunk.doc_type).toBe("10-k");
    expect(chunk.section).toBe("risk_factors");
    expect(chunk.url).toBe("https://sec.gov/x");
    expect("isStale" in chunk).toBe(false); // never present when the flag is off — not even as undefined-valued key noise
  });

  it("includes isStale when RAG_CITATION_STALENESS is on, computed from as_of + doc_type", async () => {
    process.env.RAG_CITATION_STALENESS = "on";
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    mocks.retrieveContextDetailed.mockResolvedValue([
      {
        id: "AAPL-8K#c002",
        text: "Apple announced a buyback.",
        score: 0.7,
        source: "sec-8k",
        as_of: oldDate,
        doc_type: "8-k"
      }
    ]);
    const { buildProductionDeps } = await import("../src/lib/chat/orchestrator");
    const deps = buildProductionDeps();

    const results = await deps.searchKnowledge({ query: "buyback", ticker: "AAPL" }, "local");

    expect(results[0]!.isStale).toBe(true); // an 8-K at 200 days old is past its ~90d horizon
  });

  it("isStale is advisory-only: never present in the payload used by the retrieval scoring path itself", async () => {
    // Sanity: confirm the underlying chunk's `score` (cosine similarity) is untouched by staleness.
    process.env.RAG_CITATION_STALENESS = "on";
    mocks.retrieveContextDetailed.mockResolvedValue([
      { id: "x", text: "t", score: 0.42, source: "s", as_of: new Date().toISOString(), doc_type: "8-k" }
    ]);
    const { buildProductionDeps } = await import("../src/lib/chat/orchestrator");
    const deps = buildProductionDeps();

    const results = await deps.searchKnowledge({ query: "q", ticker: "AAPL" }, "local");
    expect(results[0]!.score).toBe(0.42);
    expect(results[0]!.isStale).toBe(false); // fresh, not stale
  });

  it("returns [] when no ticker is provided (unchanged existing behavior)", async () => {
    const { buildProductionDeps } = await import("../src/lib/chat/orchestrator");
    const deps = buildProductionDeps();
    const results = await deps.searchKnowledge({ query: "q" }, "local");
    expect(results).toEqual([]);
    expect(mocks.retrieveContextDetailed).not.toHaveBeenCalled();
  });
});
