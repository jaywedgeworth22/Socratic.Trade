// Follow-on Workstream B — P0-2 (paired-t significance), P0-3 (fail-closed tuning-config guard),
// P0-4 (unified learning-mutation ledger + revert). Temp SQLite per run; never the dev app.db.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { validateTuningInvariants } from "../src/lib/tuning-invariants";
import {
  recordLearningMutation,
  revertLearningMutation,
  LEARNING_SUBSYSTEM_SCORING_WEIGHTS
} from "../src/lib/learning-ledger";
import { applyAutonomousWeightTuning, revertAutonomousWeightTuning, autonomousOosThresholds } from "../src/lib/strategy-tuning";
import type { ScoringWeights, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ll-followon-${randomUUID()}.db`)}`;
});

function policyFor(account: string, tuning?: TradingPolicy["tuning"]): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    paperMode: true,
    scoringWeights: { ...DEFAULT_POLICY.scoringWeights },
    tuning
  };
}

// ── P0-3: fail-closed tuning-config invariant guard (pure validator) ────────────────────────────
describe("validateTuningInvariants — P0-3", () => {
  it("undefined / empty tuning is valid (all defaults)", () => {
    expect(validateTuningInvariants(undefined).ok).toBe(true);
    expect(validateTuningInvariants({}).ok).toBe(true);
  });

  it("flags a non-positive sample gate", () => {
    const r = validateTuningInvariants({ minClosedLotsForWeightShift: 0 });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "min_closed_lots_nonpositive")).toBe(true);
  });

  it("flags an inverted sizing band (floor > ceiling)", () => {
    const r = validateTuningInvariants({ sizingFloorPct: 80, sizingCeilingPct: 20 });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "sizing_floor_above_ceiling")).toBe(true);
  });

  it("flags autoApplyWeights with oosWithholdUnvalidated=false and no override", () => {
    const r = validateTuningInvariants({ autoApplyWeights: true, oosWithholdUnvalidated: false });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "auto_apply_without_oos_withhold")).toBe(true);
  });

  it("the explicit override clears the auto-apply / oos-withhold coupling", () => {
    const r = validateTuningInvariants({ autoApplyWeights: true, oosWithholdUnvalidated: false, autoApplyOverrideUnvalidated: true });
    expect(r.ok).toBe(true);
  });

  it("autoApplyWeights with oosWithholdUnvalidated left default (true) is valid", () => {
    expect(validateTuningInvariants({ autoApplyWeights: true }).ok).toBe(true);
  });
});

// ── P0-3: fail-closed at the AUTONOMOUS apply path (skip + audit, never throw) ───────────────────
describe("applyAutonomousWeightTuning — P0-3 fail-closed", () => {
  it("an invariant violation SKIPS the apply, writes a skip audit row, does not throw, weights untouched", async () => {
    const { setPolicy, getPolicy, latestAuditByKind } = await import("../src/lib/db");
    const userId = `p03-${randomUUID()}`;
    // autoApplyWeights on + oosWithholdUnvalidated=false + no override → invariant violation.
    setPolicy(policyFor("P03-A", { autoApplyWeights: true, oosWithholdUnvalidated: false }), userId);
    const before = { ...getPolicy(userId).scoringWeights };

    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("invariant_violation");
    expect(getPolicy(userId).scoringWeights).toEqual(before);
    expect(latestAuditByKind("auto_weight_apply_skipped", userId)).toBeTruthy();
  });
});

// ── P0-2: policy-driven thresholds thread the margin + paired-t through ──────────────────────────
describe("autonomousOosThresholds — P0-2", () => {
  it("defaults keep the env margin and a no-op paired-t (0)", () => {
    const th = autonomousOosThresholds(undefined);
    expect(th.minPairedTStat).toBe(0);
    expect(th.minICDelta).toBeGreaterThanOrEqual(0);
  });

  it("policy minOosICImprovement raises the IC-delta margin above the env floor", () => {
    const th = autonomousOosThresholds({ minOosICImprovement: 0.5 });
    expect(th.minICDelta).toBe(0.5); // 0.5 > env default 0.005
  });

  it("policy minOosPairedTStat is surfaced for the significance gate", () => {
    expect(autonomousOosThresholds({ minOosPairedTStat: 2 }).minPairedTStat).toBe(2);
  });
});

// ── P0-4: unified learning-mutation ledger + revert ─────────────────────────────────────────────
describe("learning-mutation ledger + revert — P0-4", () => {
  it("records a mutation and reverts it, restoring the prior weights via setPolicy", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `p04-${randomUUID()}`;
    setPolicy(policyFor("P04-A"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;

    // Simulate an apply: bump momentum, persist, and record the ledger row (capturing `before` = prior).
    const bumped: ScoringWeights = { ...prior, momentum: prior.momentum + 0.05 };
    setPolicy({ ...getPolicy(userId), scoringWeights: bumped }, userId);
    const entryId = recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      before: { scoringWeights: prior },
      after: { scoringWeights: bumped },
      evidence: { candidateIC: 0.05 }
    });
    expect(entryId).toBeTruthy();
    expect(getPolicy(userId).scoringWeights.momentum).toBeCloseTo(prior.momentum + 0.05, 5);

    const result = revertLearningMutation({ subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS, userId });
    expect(result.reverted).toBe(true);
    expect(result.entryId).toBe(entryId);
    // Restored via setPolicy → getPolicy (which reads through the active-profile mirror) reflects the prior.
    expect(getPolicy(userId).scoringWeights.momentum).toBeCloseTo(prior.momentum, 5);
  });

  it("revert is idempotent: a second revert of the same latest row reports no prior mutation", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `p04-idem-${randomUUID()}`;
    setPolicy(policyFor("P04-IDEM"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;
    recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      before: { scoringWeights: prior },
      after: { scoringWeights: { ...prior, value: prior.value + 0.03 } }
    });

    expect(revertLearningMutation({ userId }).reverted).toBe(true);
    // The row is now marked reverted, so it's no longer the "latest non-reverted" → nothing to revert.
    expect(revertLearningMutation({ userId }).reverted).toBe(false);
  });

  it("revert is a no-op when the ledger is empty", () => {
    const userId = `p04-empty-${randomUUID()}`;
    const r = revertLearningMutation({ userId, subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS });
    expect(r.reverted).toBe(false);
    expect(r.reason).toBe("no_prior_mutation");
  });

  it("subsystem scoping: reverting scoring_weights ignores a different subsystem's row", () => {
    const userId = `p04-scope-${randomUUID()}`;
    recordLearningMutation({ subsystem: "some_other_subsystem", userId, before: {}, after: {} });
    // Only an other-subsystem row exists → the scoring_weights revert finds nothing.
    expect(revertLearningMutation({ userId, subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS }).reverted).toBe(false);
  });

  it("listLearningMutations returns rows newest-first, filterable by subsystem", async () => {
    const { listLearningMutations } = await import("../src/lib/db");
    const userId = `p04-list-${randomUUID()}`;
    recordLearningMutation({ subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS, userId, before: { scoringWeights: { a: 1 } }, after: { scoringWeights: { a: 2 } } });
    const rows = listLearningMutations(userId, { subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS });
    expect(rows.length).toBe(1);
    expect(rows[0].subsystem).toBe(LEARNING_SUBSYSTEM_SCORING_WEIGHTS);
    expect(rows[0].beforeState).toEqual({ scoringWeights: { a: 1 } });
  });

  it("revertAutonomousWeightTuning uses the unified ledger when a ledger row exists", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `p04-auto-${randomUUID()}`;
    setPolicy(policyFor("P04-AUTO"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;
    const bumped: ScoringWeights = { ...prior, quality: prior.quality + 0.04 };
    setPolicy({ ...getPolicy(userId), scoringWeights: bumped }, userId);
    recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      before: { scoringWeights: prior },
      after: { scoringWeights: bumped }
    });

    const result = revertAutonomousWeightTuning(userId);
    expect(result.reverted).toBe(true);
    expect(getPolicy(userId).scoringWeights.quality).toBeCloseTo(prior.quality, 5);
  });
});
