// retrieval-usefulness join + advisory ranking nudge (handoff 4.1).
// Verifies: the join credits attributed ids only for matured outcomes; passes are idempotent
// (credited-ledger watermark) even when the decision row is rewritten later; aggregates are
// correct on a small fixture; the ranking weight is bounded and applies; the re-rank is
// RANK-STABLE (positional RRF base: neutral/equal multipliers return the incoming order
// byte-identical — upstream ordering semantics like the hybrid RRF fusion are preserved);
// retrieval order is unchanged when stats are absent or the toggle is off.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-retrieval-usefulness-${randomUUID()}.db`)}`;
});

afterEach(() => {
  delete process.env.RETRIEVAL_USEFULNESS_WEIGHTING;
});

type Attribution = { chunkId?: string; docType?: string };

async function seedDecision(input: {
  userId: string;
  attributions: Attribution[];
  outcome?: {
    status: "open" | "won" | "lost" | "flat" | "unknown" | "unresolvable";
    returnPct?: number;
    outcomes: Array<{ horizon: "15m" | "1h" | "1d" | "1w"; returnPct?: number; resolution: "ok" | "unresolvable"; reason?: string }>;
  };
}): Promise<string> {
  const { upsertSocraticDecisionCase } = await import("../src/lib/db");
  return upsertSocraticDecisionCase({
    userId: input.userId,
    proposalId: `p-${randomUUID()}`,
    symbol: "AAPL",
    side: "buy",
    status: "placed",
    authority: "decide",
    thesis: "Value-Quality",
    rationale: "fixture",
    action: "BUY AAPL $100",
    ragAttributions: input.attributions.map((attr) => ({
      symbol: "AAPL",
      query: "fixture query",
      ...(attr.chunkId ? { chunkId: attr.chunkId } : {}),
      ...(attr.docType ? { docType: attr.docType } : {}),
      text: "fixture chunk text",
      contribution: "fixture"
    })),
    ...(input.outcome ? { outcome: input.outcome } : {})
  });
}

describe("retrieval-usefulness join", () => {
  it("credits attributed ids only for matured outcomes, with correct aggregates", async () => {
    const userId = `ru-join-${randomUUID()}`;
    const { runRetrievalUsefulnessJoin } = await import("../src/lib/retrieval-usefulness");
    const { getRetrievalUsefulnessStats, getRetrievalUsefulnessSummary } = await import("../src/lib/db");

    // Matured winner: two horizons resolved + headline.
    await seedDecision({
      userId,
      attributions: [
        { chunkId: "vec-analog-1", docType: "socratic-decision" },
        { chunkId: "vec-coach-1", docType: "coach-note" }
      ],
      outcome: {
        status: "won",
        returnPct: 8,
        outcomes: [
          { horizon: "1d", returnPct: 5, resolution: "ok" },
          { horizon: "1w", returnPct: 8, resolution: "ok" },
          { horizon: "15m", resolution: "unresolvable", reason: "no_intraday_source" }
        ]
      }
    });
    // Matured loser at 1d only (no headline returnPct).
    await seedDecision({
      userId,
      attributions: [{ chunkId: "vec-analog-2", docType: "socratic-decision" }],
      outcome: { status: "lost", outcomes: [{ horizon: "1d", returnPct: -3, resolution: "ok" }] }
    });
    // Still open: must NOT be credited.
    await seedDecision({
      userId,
      attributions: [{ chunkId: "vec-open", docType: "socratic-decision" }],
      outcome: { status: "open", outcomes: [] }
    });
    // Matured but no attributions: not scanned (nothing to credit).
    await seedDecision({ userId, attributions: [], outcome: { status: "won", returnPct: 2, outcomes: [] } });

    const result = runRetrievalUsefulnessJoin(userId);
    expect(result.credited).toBe(2);

    const kindRows = getRetrievalUsefulnessStats(userId);
    const analog1d = kindRows.find((r) => r.docType === "socratic-decision" && r.memoryKind === "analog" && r.horizon === "1d");
    expect(analog1d).toMatchObject({ samples: 2, wins: 1, losses: 1, hitRate: 0.5 });
    expect(analog1d?.meanReturnPct).toBeCloseTo(1, 4); // (5 + -3) / 2
    const coach1d = kindRows.find((r) => r.docType === "coach-note" && r.memoryKind === "coaching" && r.horizon === "1d");
    expect(coach1d).toMatchObject({ samples: 1, wins: 1, losses: 0 });
    const analogHeadline = kindRows.find((r) => r.docType === "socratic-decision" && r.horizon === "headline");
    expect(analogHeadline).toMatchObject({ samples: 1, wins: 1 }); // loser had no headline returnPct

    // Per-doc granularity: the specific vector id carries its own row.
    const perDoc = getRetrievalUsefulnessStats(userId, { docId: "vec-analog-1", horizon: "1w" });
    expect(perDoc).toHaveLength(1);
    expect(perDoc[0]).toMatchObject({ samples: 1, wins: 1, returnPctSum: 8 });
    // The open case's chunk was never credited.
    expect(getRetrievalUsefulnessStats(userId, { docId: "vec-open" })).toHaveLength(0);

    const summary = getRetrievalUsefulnessSummary(userId);
    expect(summary.creditedDecisions).toBe(2);
    expect(summary.kinds.some((k) => k.docType === "socratic-decision" && k.memoryKind === "analog")).toBe(true);
  });

  it("is idempotent across passes, including after the decision row is rewritten", async () => {
    const userId = `ru-idem-${randomUUID()}`;
    const { runRetrievalUsefulnessJoin } = await import("../src/lib/retrieval-usefulness");
    const { getRetrievalUsefulnessStats, getSocraticDecisionCase, upsertSocraticDecisionCase } = await import("../src/lib/db");

    const id = await seedDecision({
      userId,
      attributions: [{ chunkId: "vec-x", docType: "socratic-decision" }],
      outcome: { status: "won", returnPct: 4, outcomes: [{ horizon: "1d", returnPct: 4, resolution: "ok" }] }
    });

    expect(runRetrievalUsefulnessJoin(userId).credited).toBe(1);
    const after1 = getRetrievalUsefulnessStats(userId);

    // Second pass: nothing new to scan.
    const second = runRetrievalUsefulnessJoin(userId);
    expect(second).toMatchObject({ scanned: 0, credited: 0, creditsWritten: 0 });

    // Rewrite the row (lessons/coach-note style upsert bumps updated_at) — still exactly-once.
    const existing = getSocraticDecisionCase(id, userId);
    expect(existing).toBeDefined();
    upsertSocraticDecisionCase({ ...existing!, userId, lessons: ["post-mortem lesson"] });
    const third = runRetrievalUsefulnessJoin(userId);
    expect(third).toMatchObject({ scanned: 0, credited: 0 });
    expect(getRetrievalUsefulnessStats(userId)).toEqual(after1);
  });

  it("credits terminal 'unresolvable' cases into the ledger without writing stats", async () => {
    const userId = `ru-unres-${randomUUID()}`;
    const { runRetrievalUsefulnessJoin } = await import("../src/lib/retrieval-usefulness");
    const { getRetrievalUsefulnessStats, getRetrievalUsefulnessSummary } = await import("../src/lib/db");

    await seedDecision({
      userId,
      attributions: [{ chunkId: "vec-u", docType: "lesson" }],
      outcome: { status: "unresolvable", outcomes: [{ horizon: "1d", resolution: "unresolvable", reason: "no_price_series" }] }
    });
    const result = runRetrievalUsefulnessJoin(userId);
    expect(result.credited).toBe(1);
    expect(result.creditsWritten).toBe(0);
    expect(getRetrievalUsefulnessStats(userId)).toHaveLength(0);
    expect(getRetrievalUsefulnessSummary(userId).creditedDecisions).toBe(1);
    // And it is never rescanned.
    expect(runRetrievalUsefulnessJoin(userId).scanned).toBe(0);
  });

  it("runs at most once per UTC day via the IfDue guard", async () => {
    const userId = `ru-due-${randomUUID()}`;
    const { runRetrievalUsefulnessJoinIfDue } = await import("../src/lib/retrieval-usefulness");
    await seedDecision({
      userId,
      attributions: [{ chunkId: "vec-d", docType: "socratic-decision" }],
      outcome: { status: "flat", returnPct: 0, outcomes: [{ horizon: "1d", returnPct: 0, resolution: "ok" }] }
    });
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(runRetrievalUsefulnessJoinIfDue(userId, now)?.credited).toBe(1);
    expect(runRetrievalUsefulnessJoinIfDue(userId, now + 60_000)).toBeUndefined();
    // Next UTC day: due again (nothing left to credit, but the pass runs).
    expect(runRetrievalUsefulnessJoinIfDue(userId, now + 24 * 3_600_000)).toMatchObject({ scanned: 0 });
  });
});

describe("advisory usefulness weighting", () => {
  it("bounds the multiplier to [0.9, 1.1] and stays neutral under the sample floor", async () => {
    const { usefulnessMultiplier, USEFULNESS_MIN_SAMPLES } = await import("../src/lib/retrieval-usefulness");
    expect(usefulnessMultiplier(undefined)).toBe(1);
    expect(usefulnessMultiplier({ samples: USEFULNESS_MIN_SAMPLES - 1, wins: 4, losses: 0 })).toBe(1);
    expect(usefulnessMultiplier({ samples: 10, wins: 0, losses: 0 })).toBe(1);
    expect(usefulnessMultiplier({ samples: 100, wins: 100, losses: 0 })).toBe(1.1); // clamped, never more
    expect(usefulnessMultiplier({ samples: 100, wins: 0, losses: 100 })).toBe(0.9); // clamped, never less
    expect(usefulnessMultiplier({ samples: 10, wins: 5, losses: 5 })).toBe(1); // coin-flip = neutral
  });

  it("reorders retrieval candidates toward kinds with better matured outcomes", async () => {
    const userId = `ru-weight-${randomUUID()}`;
    const { applyRetrievalUsefulnessWeighting, clearRetrievalUsefulnessWeightCache } = await import(
      "../src/lib/retrieval-usefulness"
    );
    const { creditRetrievalUsefulness } = await import("../src/lib/db");

    // 6 winning coaching credits, 6 losing analog credits (>= sample floor each).
    for (let i = 0; i < 6; i += 1) {
      creditRetrievalUsefulness(userId, `d-coach-${i}`, [
        { docType: "coach-note", memoryKind: "coaching", horizon: "headline", returnPct: 2 }
      ]);
      creditRetrievalUsefulness(userId, `d-analog-${i}`, [
        { docType: "socratic-decision", memoryKind: "analog", horizon: "headline", returnPct: -2 }
      ]);
    }
    clearRetrievalUsefulnessWeightCache();

    const analog = { doc_type: "socratic-decision", score: 0.8 };
    const coach = { doc_type: "coach-note", score: 0.75 };
    // Positional RRF base: analog #0 -> 0.9/60 = 0.0150; coach #1 -> 1.1/61 = 0.0180 -> coach first.
    expect(applyRetrievalUsefulnessWeighting([analog, coach], userId)).toEqual([coach, analog]);
    // Rank-stable by design: the base is POSITIONAL, so an incoming order that does not follow the
    // raw scores (e.g. the hybrid RRF-fused order) is respected — same-kind chunks (equal
    // multipliers) can never swap, whatever their scores say.
    const rrfFused = [
      { doc_type: "socratic-decision", score: 0.6 },
      { doc_type: "socratic-decision", score: 0.9 }
    ];
    expect(applyRetrievalUsefulnessWeighting(rrfFused, userId)).toEqual(rrfFused);
  });

  it("rank-stable: all-neutral multipliers return the incoming order byte-identical, even with stats present", async () => {
    const userId = `ru-neutral-${randomUUID()}`;
    const { applyRetrievalUsefulnessWeighting, clearRetrievalUsefulnessWeightCache } = await import(
      "../src/lib/retrieval-usefulness"
    );
    const { creditRetrievalUsefulness } = await import("../src/lib/db");

    // Stats EXIST but are exactly coin-flip (3 wins, 3 losses >= sample floor) -> multiplier 1.0,
    // alongside a kind with no stats at all (also 1.0). This exercises the reorder path, not the
    // stats-absent early return.
    for (let i = 0; i < 6; i += 1) {
      creditRetrievalUsefulness(userId, `d-n-${i}`, [
        { docType: "coach-note", memoryKind: "coaching", horizon: "headline", returnPct: i < 3 ? 2 : -2 }
      ]);
    }
    clearRetrievalUsefulnessWeightCache();

    // Deliberately NOT sorted by score — stands in for an upstream RRF-fused order that a
    // score-based re-sort would have destroyed.
    const chunks = [
      { doc_type: "socratic-decision", score: 0.5 },
      { doc_type: "coach-note", score: 0.95 },
      { doc_type: "socratic-decision", score: 0.7 }
    ];
    const result = applyRetrievalUsefulnessWeighting(chunks, userId);
    expect(result).toHaveLength(chunks.length);
    for (let i = 0; i < chunks.length; i += 1) {
      expect(result[i]).toBe(chunks[i]); // same references, same positions — byte-identical order
    }
  });

  it("leaves order unchanged when stats are absent or the toggle is off", async () => {
    const { applyRetrievalUsefulnessWeighting, clearRetrievalUsefulnessWeightCache, retrievalUsefulnessWeightingEnabled } =
      await import("../src/lib/retrieval-usefulness");
    const { creditRetrievalUsefulness } = await import("../src/lib/db");
    clearRetrievalUsefulnessWeightCache();

    const chunks = [
      { doc_type: "socratic-decision", score: 0.8 },
      { doc_type: "coach-note", score: 0.75 }
    ];
    // No stats for this user at all -> identical order (fail-open to similarity).
    expect(applyRetrievalUsefulnessWeighting(chunks, `ru-nostats-${randomUUID()}`)).toEqual(chunks);

    // Toggle off -> identical order even with strong stats.
    const userId = `ru-off-${randomUUID()}`;
    for (let i = 0; i < 6; i += 1) {
      creditRetrievalUsefulness(userId, `d-${i}`, [
        { docType: "coach-note", memoryKind: "coaching", horizon: "headline", returnPct: 2 },
        { docType: "socratic-decision", memoryKind: "analog", horizon: "headline", returnPct: -2 }
      ]);
    }
    clearRetrievalUsefulnessWeightCache();
    process.env.RETRIEVAL_USEFULNESS_WEIGHTING = "off";
    expect(retrievalUsefulnessWeightingEnabled()).toBe(false);
    expect(applyRetrievalUsefulnessWeighting(chunks, userId)).toEqual(chunks);
    delete process.env.RETRIEVAL_USEFULNESS_WEIGHTING;
    expect(applyRetrievalUsefulnessWeighting(chunks, userId)).not.toEqual(chunks);
  });
});
