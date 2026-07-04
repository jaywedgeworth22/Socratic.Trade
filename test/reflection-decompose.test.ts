// Decomposed reflection lessons + regime/thesis-conditioned retrieval + per-account
// reflection keying (2026-07-04 composite review A: "Decompose reflection into structured,
// regime/thesis-conditioned, retrievable lessons" [Both], "Stamp and use regime on learned
// facts", "Reflection keying + history" [Both]).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ClosedLot } from "../src/lib/performance";
import type { LearnedContextRow } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-reflection-decompose-${randomUUID()}.db`)}`;
});

function lot(overrides: Partial<ClosedLot> = {}): ClosedLot {
  return {
    pnl: 50,
    returnPct: 2,
    symbol: "AAPL",
    thesisTag: "Momentum Breakout",
    regime: "Risk-On",
    dominantFactor: "momentum",
    ...overrides
  };
}

function factRow(userId: string, overrides: Partial<LearnedContextRow> = {}): LearnedContextRow {
  return {
    id: randomUUID(),
    userId,
    scope: "private",
    kind: "fact",
    subject: `subject-${randomUUID().slice(0, 8)}`,
    symbol: null,
    value: "a fact",
    source: "inferred",
    origin: "autonomous",
    riskTier: "fact",
    confidence: 0.5,
    contributorUserId: userId,
    assertedAt: new Date().toISOString(),
    supersededBy: null,
    expiresAt: null,
    ...overrides
  };
}

describe("writeDecomposedLessons", () => {
  it("writes tagged lesson rows per (thesis x regime) bucket and embeds them as doc_type 'lesson'", async () => {
    const userId = `lessons-${randomUUID()}`;
    const { writeDecomposedLessons, lessonSubject } = await import("../src/lib/post-mortem");
    const { findLiveLearnedContextBySubject } = await import("../src/lib/db");

    // 6 lots in one regime bucket: 4 winners / 2 losers, MAE/MFE persisted on 4 of them.
    const lots: ClosedLot[] = [
      lot({ pnl: 100, returnPct: 4, mae: -2, mfe: 8 }),
      lot({ pnl: 80, returnPct: 3, mae: -1, mfe: 6 }),
      lot({ pnl: 60, returnPct: 2, mae: -3, mfe: 5 }),
      lot({ pnl: 40, returnPct: 1, mae: -2, mfe: 5 }),
      lot({ pnl: -50, returnPct: -2 }),
      lot({ pnl: -30, returnPct: -1, dominantFactor: "value" })
    ];

    const embedded: Array<{ text: string; metadata?: Record<string, unknown> }> = [];
    const result = await writeDecomposedLessons(userId, "ACCT-A", lots, {
      embed: async (docs) => {
        embedded.push(...docs);
      }
    });

    expect(result.written).toBe(1);
    expect(result.embedded).toBe(1);

    const subject = lessonSubject({ thesisTag: "Momentum Breakout", regime: "Risk-On" });
    const row = findLiveLearnedContextBySubject(userId, "pattern", subject, null);
    expect(row).not.toBeNull();
    // Tag columns carry the conditioning dimensions.
    expect(row!.regime).toBe("Risk-On");
    expect(row!.thesisTag).toBe("Momentum Breakout");
    expect(row!.dominantFactor).toBe("momentum"); // modal factor (5 momentum vs 1 value)
    expect(row!.riskTier).toBe("fact");
    // Value carries realized win-rate + MAE/MFE/capture.
    expect(row!.value).toContain("win rate 67%");
    expect(row!.value).toContain("6 closed lots");
    expect(row!.value).toContain("avg MAE");
    expect(row!.value).toContain("avg MFE");
    expect(row!.value).toContain("capture");

    // Embedded as a doc_type 'lesson' vector carrying the same stats.
    expect(embedded).toHaveLength(1);
    expect(embedded[0].metadata?.doc_type).toBe("lesson");
    expect(embedded[0].metadata?.thesis_tag).toBe("Momentum Breakout");
    expect(embedded[0].metadata?.entry_market_regime).toBe("Risk-On");
    expect(embedded[0].metadata?.account_number).toBe("ACCT-A");
    expect(embedded[0].text).toContain("win rate 67%");
  });

  it("gates emission on min sample size with a regime-agnostic fallback for thin regimes", async () => {
    const userId = `lessons-thin-${randomUUID()}`;
    const { writeDecomposedLessons, lessonSubject, MIN_LOTS_FOR_LESSON } = await import("../src/lib/post-mortem");
    const { findLiveLearnedContextBySubject } = await import("../src/lib/db");

    // "Dip Buy": 6 total lots but split 3/3 across regimes — no single regime bucket clears the
    // gate, so ONE regime-agnostic (regime=null) lesson is emitted instead.
    // "Rare": 2 lots — below the gate entirely, no lesson.
    const lots: ClosedLot[] = [
      ...Array.from({ length: 3 }, () => lot({ thesisTag: "Dip Buy", regime: "Risk-On", pnl: 10, returnPct: 1 })),
      ...Array.from({ length: 3 }, () => lot({ thesisTag: "Dip Buy", regime: "High-Vol", pnl: -10, returnPct: -1 })),
      ...Array.from({ length: 2 }, () => lot({ thesisTag: "Rare", regime: "Risk-On" }))
    ];
    expect(lots.filter((l) => l.thesisTag === "Rare").length).toBeLessThan(MIN_LOTS_FOR_LESSON);

    const result = await writeDecomposedLessons(userId, "ACCT-A", lots, { embed: async () => {} });
    expect(result.written).toBe(1);

    const agnostic = findLiveLearnedContextBySubject(
      userId,
      "pattern",
      lessonSubject({ thesisTag: "Dip Buy", regime: null }),
      null
    );
    expect(agnostic).not.toBeNull();
    expect(agnostic!.regime).toBeNull(); // regime-agnostic — claims no conditioning it lacks sample for
    expect(agnostic!.thesisTag).toBe("Dip Buy");
    expect(agnostic!.value).toContain("across all regimes");

    expect(findLiveLearnedContextBySubject(userId, "pattern", lessonSubject({ thesisTag: "Rare", regime: "Risk-On" }), null)).toBeNull();
    expect(findLiveLearnedContextBySubject(userId, "pattern", lessonSubject({ thesisTag: "Rare", regime: null }), null)).toBeNull();
  });

  it("is idempotent on unchanged stats and supersedes on changed stats", async () => {
    const userId = `lessons-idem-${randomUUID()}`;
    const { writeDecomposedLessons, lessonSubject } = await import("../src/lib/post-mortem");
    const { findLiveLearnedContextBySubject } = await import("../src/lib/db");

    const lots: ClosedLot[] = Array.from({ length: 5 }, () => lot({ pnl: 20, returnPct: 1 }));
    const embed = vi.fn(async () => {});

    const first = await writeDecomposedLessons(userId, "ACCT-A", lots, { embed });
    expect(first.written).toBe(1);
    const firstRow = findLiveLearnedContextBySubject(userId, "pattern", lessonSubject({ thesisTag: "Momentum Breakout", regime: "Risk-On" }), null);

    // Same lots again → identical value → no new row, no re-embed.
    const second = await writeDecomposedLessons(userId, "ACCT-A", lots, { embed });
    expect(second.written).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);

    // A sixth lot changes the stats → supersede-in-place.
    const third = await writeDecomposedLessons(userId, "ACCT-A", [...lots, lot({ pnl: -40, returnPct: -3 })], { embed });
    expect(third.written).toBe(1);
    const latest = findLiveLearnedContextBySubject(userId, "pattern", lessonSubject({ thesisTag: "Momentum Breakout", regime: "Risk-On" }), null);
    expect(latest!.id).not.toBe(firstRow!.id);
    expect(latest!.value).toContain("6 closed lots");
  });

  it("embedding failure never fails the learned_context write", async () => {
    const userId = `lessons-embedfail-${randomUUID()}`;
    const { writeDecomposedLessons, lessonSubject } = await import("../src/lib/post-mortem");
    const { findLiveLearnedContextBySubject } = await import("../src/lib/db");

    const result = await writeDecomposedLessons(
      userId,
      "ACCT-A",
      Array.from({ length: 5 }, () => lot()),
      { embed: async () => { throw new Error("pinecone down"); } }
    );
    expect(result.written).toBe(1);
    expect(result.embedded).toBe(0);
    expect(findLiveLearnedContextBySubject(userId, "pattern", lessonSubject({ thesisTag: "Momentum Breakout", regime: "Risk-On" }), null)).not.toBeNull();
  });
});

describe("retrieveLearnedContext regime/thesis conditioning", () => {
  it("boosts current-regime rows above newer mismatched rows and labels mismatches without filtering", async () => {
    const userId = `regime-boost-${randomUUID()}`;
    const { insertLearnedContext } = await import("../src/lib/db");
    const { retrieveLearnedContext } = await import("../src/lib/learned-context/store");

    // Mismatched-regime row is the NEWEST — under pure recency it would rank first.
    insertLearnedContext(factRow(userId, {
      subject: "panic-lesson",
      value: "cut losers fast",
      regime: "High-Vol Panic",
      assertedAt: "2026-07-03T00:00:00.000Z"
    }));
    insertLearnedContext(factRow(userId, {
      subject: "trend-lesson",
      value: "let winners run",
      regime: "Risk-On",
      assertedAt: "2026-07-01T00:00:00.000Z"
    }));
    insertLearnedContext(factRow(userId, {
      subject: "untagged-fact",
      value: "generic fact",
      assertedAt: "2026-07-02T00:00:00.000Z"
    }));

    const facts = retrieveLearnedContext(userId, [], "Risk-On", { includeShared: false });
    expect(facts).toHaveLength(3); // mismatched row is served, never filtered out
    expect(facts[0]).toContain("trend-lesson"); // regime match outranks recency
    expect(facts[1]).toContain("untagged-fact"); // untagged keeps neutral rank
    expect(facts[2]).toContain("panic-lesson");
    expect(facts[2]).toContain("(learned in High-Vol Panic)"); // labeled, not dropped
    expect(facts[0]).not.toContain("(learned in"); // matching rows carry no label
    expect(facts[1]).not.toContain("(learned in"); // untagged rows carry no label
  });

  it("boosts candidate-thesis lesson rows; no regime arg preserves recency order unlabeled", async () => {
    const userId = `thesis-boost-${randomUUID()}`;
    const { insertLearnedContext } = await import("../src/lib/db");
    const { retrieveLearnedContext } = await import("../src/lib/learned-context/store");

    insertLearnedContext(factRow(userId, {
      subject: "lesson:Dip Buy@all-regimes",
      value: "dip buys break even",
      thesisTag: "Dip Buy",
      assertedAt: "2026-07-01T00:00:00.000Z"
    }));
    insertLearnedContext(factRow(userId, {
      subject: "newer-generic",
      value: "newer generic fact",
      assertedAt: "2026-07-03T00:00:00.000Z"
    }));

    const boosted = retrieveLearnedContext(userId, [], undefined, { includeShared: false, thesisTags: ["Dip Buy"] });
    expect(boosted[0]).toContain("Dip Buy"); // thesis match outranks recency
    expect(boosted[0]).not.toContain("(learned in");

    const unconditioned = retrieveLearnedContext(userId, [], undefined, { includeShared: false });
    expect(unconditioned[0]).toContain("newer-generic"); // pure recency without conditioning
  });
});

describe("reflection blob demotion", () => {
  it("keeps the per-account blob as fallback with zero lessons, demotes it once lessons exist", async () => {
    const userId = `demote-${randomUUID()}`;
    const { resolveReflectionForPrompt, writeDecomposedLessons, REFLECTION_DEMOTED_NOTE } = await import("../src/lib/post-mortem");
    const { appendReflectionVersion } = await import("../src/lib/db");

    // No reflection, no lessons → empty.
    expect(resolveReflectionForPrompt(userId, "ACCT-A")).toBe("");

    // Blob exists, zero structured lessons → blob is the fallback.
    appendReflectionVersion(userId, "ACCT-A", "Trade smaller in panics.", "hash-1");
    expect(resolveReflectionForPrompt(userId, "ACCT-A")).toBe("Trade smaller in panics.");

    // Structured lessons exist → the blob leaves the system prompt (static pointer instead).
    await writeDecomposedLessons(userId, "ACCT-A", Array.from({ length: 5 }, () => lot()), { embed: async () => {} });
    expect(resolveReflectionForPrompt(userId, "ACCT-A")).toBe(REFLECTION_DEMOTED_NOTE);
  });
});

describe("reflection keying + history (per-account, append-only, versioned)", () => {
  it("keys reflections by (userId, accountNumber): two accounts never clobber each other", async () => {
    const userId = `keying-${randomUUID()}`;
    const { appendReflectionVersion, getLatestReflectionVersion, listReflectionVersions } = await import("../src/lib/db");

    appendReflectionVersion(userId, "ACCT-A", "Account A v1", "hash-a1");
    appendReflectionVersion(userId, "ACCT-B", "Account B v1", "hash-b1");
    appendReflectionVersion(userId, "ACCT-A", "Account A v2", "hash-a2");

    // Regression: writing B (and a new A version) never clobbers the other account's row.
    const latestA = getLatestReflectionVersion(userId, "ACCT-A");
    const latestB = getLatestReflectionVersion(userId, "ACCT-B");
    expect(latestA?.summary).toBe("Account A v2");
    expect(latestA?.version).toBe(2);
    expect(latestB?.summary).toBe("Account B v1");
    expect(latestB?.version).toBe(1);

    // Append-only history with the input-stats hash on every version.
    const historyA = listReflectionVersions(userId, "ACCT-A");
    expect(historyA.map((v) => v.version)).toEqual([2, 1]);
    expect(historyA.map((v) => v.inputStatsHash)).toEqual(["hash-a2", "hash-a1"]);
    expect(historyA.map((v) => v.summary)).toEqual(["Account A v2", "Account A v1"]);
  });

  it("regeneration-gate signature keys are per (userId, accountNumber)", async () => {
    const { reflectionSignatureKey } = await import("../src/lib/post-mortem");
    expect(reflectionSignatureKey("u1", "ACCT-A")).not.toBe(reflectionSignatureKey("u1", "ACCT-B"));
    expect(reflectionSignatureKey("u1", "ACCT-A")).not.toBe(reflectionSignatureKey("u2", "ACCT-A"));
  });
});
