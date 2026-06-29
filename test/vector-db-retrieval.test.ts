import { afterEach, describe, expect, it } from "vitest";
import { buildExtraFilters, defaultMinScore, isWithinAsOf, rerankMatches } from "../src/lib/vector-db";

describe("buildExtraFilters", () => {
  it("is empty with no options", () => {
    expect(buildExtraFilters()).toEqual({});
    expect(buildExtraFilters({})).toEqual({});
  });
  it("matches doc_type across casings (stored values are inconsistent: '10-K' vs '8-k')", () => {
    // Each requested type expands to original + lower + upper, deduped — so a lowercase filter still
    // matches uppercase-stored "10-K"/"10-Q" chunks (the bug this fixes), and vice-versa.
    const f = buildExtraFilters({ docType: ["10-k", "10-q"] }).doc_type as { $in: string[] };
    expect(new Set(f.$in)).toEqual(new Set(["10-k", "10-K", "10-q", "10-Q"]));
    // An already-uppercase request stays matched too.
    const u = buildExtraFilters({ docType: ["8-K"] }).doc_type as { $in: string[] };
    expect(new Set(u.$in)).toEqual(new Set(["8-K", "8-k"]));
  });
  it("builds section / source clauses unchanged", () => {
    expect(buildExtraFilters({ section: "risk_factors" })).toEqual({ section: { $eq: "risk_factors" } });
    expect(buildExtraFilters({ source: "sec-8k" })).toEqual({ source: { $eq: "sec-8k" } });
  });
  it("ignores an empty docType array", () => {
    expect(buildExtraFilters({ docType: [] })).toEqual({});
  });
});

describe("defaultMinScore", () => {
  const prev = process.env.VECTOR_MIN_SCORE;
  afterEach(() => { if (prev === undefined) delete process.env.VECTOR_MIN_SCORE; else process.env.VECTOR_MIN_SCORE = prev; });
  it("defaults to 0.30, reads VECTOR_MIN_SCORE, and clamps to [0,1]", () => {
    delete process.env.VECTOR_MIN_SCORE;
    expect(defaultMinScore()).toBe(0.3);
    process.env.VECTOR_MIN_SCORE = "0"; expect(defaultMinScore()).toBe(0); // disable floor
    process.env.VECTOR_MIN_SCORE = "0.55"; expect(defaultMinScore()).toBe(0.55);
    process.env.VECTOR_MIN_SCORE = "9"; expect(defaultMinScore()).toBe(1); // clamp high
    process.env.VECTOR_MIN_SCORE = "-1"; expect(defaultMinScore()).toBe(0); // clamp low
    process.env.VECTOR_MIN_SCORE = "nonsense"; expect(defaultMinScore()).toBe(0.3); // fallback
  });
});

function fakeVoyage(impl: (args: { documents: string[]; topK?: number }) => any) {
  return { rerank: async (args: any) => impl(args) } as any;
}

const m = (id: string, text: string, score: number) => ({ id, score, metadata: { text } });

describe("rerankMatches", () => {
  it("reorders matches by the reranker's returned index order and caps at topK", async () => {
    const matches = [m("a", "alpha", 0.9), m("b", "beta", 0.8), m("c", "gamma", 0.7)];
    // Reranker says doc index 2 is most relevant, then 0.
    const voyage = fakeVoyage(() => ({ data: [{ index: 2, relevanceScore: 0.99 }, { index: 0, relevanceScore: 0.5 }] }));
    const out = await rerankMatches(voyage, "q", matches, 2);
    expect(out.map((x) => x.id)).toEqual(["c", "a"]);
  });

  it("falls back to the input order when the reranker throws", async () => {
    const matches = [m("a", "alpha", 0.9), m("b", "beta", 0.8)];
    const voyage = fakeVoyage(() => { throw new Error("rate limited"); });
    const out = await rerankMatches(voyage, "q", matches, 2);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("returns input unchanged for <=1 match or all-empty documents (no rerank call needed)", async () => {
    const one = [m("a", "alpha", 0.9)];
    expect((await rerankMatches(fakeVoyage(() => { throw new Error("should not be called"); }), "q", one, 3)).map((x) => x.id)).toEqual(["a"]);
    const empty = [{ id: "x", score: 0.5, metadata: {} }, { id: "y", score: 0.4, metadata: {} }];
    expect((await rerankMatches(fakeVoyage(() => { throw new Error("should not be called"); }), "q", empty, 2)).map((x) => x.id)).toEqual(["x", "y"]);
  });

  it("falls back when the reranker returns no data", async () => {
    const matches = [m("a", "alpha", 0.9), m("b", "beta", 0.8)];
    const out = await rerankMatches(fakeVoyage(() => ({ data: [] })), "q", matches, 2);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("isWithinAsOf (point-in-time guard, incl. 8-K acceptance_datetime)", () => {
  it("excludes a filing dated after the as-of date and includes one on/before", () => {
    const filing = { acceptance_datetime: "2026-03-10", source: "sec-8k" };
    expect(isWithinAsOf(filing, "2026-03-09")).toBe(false);
    expect(isWithinAsOf(filing, "2026-03-10")).toBe(true);
    expect(isWithinAsOf(filing, "2026-03-11")).toBe(true);
  });
  it("keeps undated chunks and ignores an unset/invalid as-of", () => {
    expect(isWithinAsOf({ source: "x" }, "2026-03-10")).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2026-03-10" }, undefined)).toBe(true);
    expect(isWithinAsOf({ acceptance_datetime: "2026-03-10" }, "not-a-date")).toBe(true);
  });
});
