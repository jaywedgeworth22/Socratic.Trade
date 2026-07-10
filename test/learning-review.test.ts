// learning-review.test.ts — the daily LLM learning-review job (src/lib/learning-review.ts).
//
// Covers the pure/deterministic parts per the repo convention (temp SQLite per run, no network):
//   - once-per-day dedup (isLearningReviewDue + marker advance, incl. on failure)
//   - verdict schema parsing/validation (parseLearningReviewVerdicts)
//   - mode gating: "annotate" NEVER mutates; "decide" applies via the existing learned-context
//     mutation paths; any LLM failure NEVER mutates.
// The LLM itself is injected through runDailyLearningReview's `llm` seam — no transport is hit.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { LearnedContextPendingRow, LearnedContextRow } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-learning-review-${randomUUID()}.db`)}`;
});

import {
  activateStrategyProfile,
  createStrategyProfile,
  deleteConnectedAccount,
  getDb,
  getPendingLearnedContext,
  getPolicy,
  insertLearnedContext,
  insertPendingLearnedContext,
  listAuditByKind,
  listLearnedContext,
  listLearnedContextForDecision,
  setPolicy,
  updateStrategyProfile,
  upsertConnectedAccount
} from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  applyLearningReviewVerdicts,
  buildLearningReviewContextPack,
  evaluateLearningReviewTrigger,
  isLearningReviewDue,
  parseLearningReviewVerdicts,
  runDailyLearningReview,
  runDailyLearningReviewIfDue,
  type LearningReviewVerdict
} from "../src/lib/learning-review";

const NOW = Date.now();

function seedLearnedRow(userId: string, overrides: Partial<LearnedContextRow> = {}): LearnedContextRow {
  const row: LearnedContextRow = {
    id: randomUUID(),
    userId,
    scope: "private",
    kind: "pattern",
    subject: `track_record:test-${randomUUID().slice(0, 8)}`,
    symbol: "MU",
    value: 'The "momentum-breakout" thesis has repeatedly lost on a realized basis.',
    source: "inferred",
    origin: "autonomous",
    riskTier: "fact",
    confidence: 0.6,
    contributorUserId: userId,
    assertedAt: new Date(NOW - 2 * 86_400_000).toISOString(),
    supersededBy: null,
    expiresAt: null,
    ...overrides
  };
  insertLearnedContext(row);
  return row;
}

function seedPendingRow(userId: string, overrides: Partial<LearnedContextPendingRow> = {}): LearnedContextPendingRow {
  const row: LearnedContextPendingRow = {
    id: randomUUID(),
    userId,
    scope: "private",
    kind: "decision",
    subject: `risk:test-${randomUUID().slice(0, 8)}`,
    value: "Avoid adding to positions when the exit pipeline is degraded.",
    symbol: null,
    source: "inferred",
    origin: "autonomous",
    riskTier: "risk",
    classifierReason: "classified 'risk' (fail-closed); queued for human confirmation",
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    status: "pending",
    resolvedAt: null,
    ...overrides
  };
  insertPendingLearnedContext(row);
  return row;
}

function enableReview(userId: string, mode: "annotate" | "decide") {
  setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewMode: mode }, userId);
}

function verdictJson(reviews: LearningReviewVerdict[], summary = "Daily review summary."): string {
  return JSON.stringify({ reviews, summary });
}

/** Injectable llm that answers "keep" for EVERY item it was shown (full coverage). */
function keepAllLlm(onCall?: () => void) {
  return async (spec: { userContent: string }) => {
    onCall?.();
    const items = (JSON.parse(spec.userContent) as { reviewItems: Array<{ id: string; table: LearningReviewVerdict["table"] }> }).reviewItems;
    return verdictJson(items.map((it) => ({ id: it.id, table: it.table, verdict: "keep" as const, confidence: 90, reasoning: "sound" })));
  };
}

// ── Verdict parsing ─────────────────────────────────────────────────────────────

describe("parseLearningReviewVerdicts", () => {
  it("parses a valid verdict payload and clamps confidence to 1-100", () => {
    const text = verdictJson([
      { id: "a", table: "learned_context", verdict: "keep", confidence: 250 as number, reasoning: "sample ok" },
      { id: "b", table: "learned_context_pending", verdict: "reject", confidence: 0 as number, reasoning: "attribution" }
    ]);
    const parsed = parseLearningReviewVerdicts(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.reviews).toHaveLength(2);
    expect(parsed!.reviews[0].confidence).toBe(100);
    expect(parsed!.reviews[1].confidence).toBe(1);
    expect(parsed!.summary).toBe("Daily review summary.");
  });

  it("tolerates code fences / surrounding prose around the JSON object", () => {
    const inner = verdictJson([{ id: "a", table: "learned_context", verdict: "expire", confidence: 70, reasoning: "still-true fails" }]);
    const parsed = parseLearningReviewVerdicts("Here you go:\n```json\n" + inner + "\n```\nDone.");
    expect(parsed?.reviews).toHaveLength(1);
    expect(parsed?.reviews[0].verdict).toBe("expire");
  });

  it("drops individually malformed entries instead of failing the whole run", () => {
    const text = JSON.stringify({
      reviews: [
        { id: "good", table: "learned_context", verdict: "keep", confidence: 80, reasoning: "ok" },
        { id: "bad-verdict", table: "learned_context", verdict: "nuke", confidence: 80, reasoning: "x" },
        { id: "bad-table", table: "policies", verdict: "keep", confidence: 80, reasoning: "x" },
        { table: "learned_context", verdict: "keep", confidence: 80, reasoning: "no id" },
        "not-an-object"
      ],
      summary: "s"
    });
    const parsed = parseLearningReviewVerdicts(text);
    expect(parsed?.reviews.map((r) => r.id)).toEqual(["good"]);
  });

  it("returns null for garbage, empty, and reviews-less payloads", () => {
    expect(parseLearningReviewVerdicts(undefined)).toBeNull();
    expect(parseLearningReviewVerdicts("")).toBeNull();
    expect(parseLearningReviewVerdicts("not json at all")).toBeNull();
    expect(parseLearningReviewVerdicts('{"summary":"no reviews"}')).toBeNull();
    expect(parseLearningReviewVerdicts('["array-root"]')).toBeNull();
  });
});

// ── Once-per-day dedup ──────────────────────────────────────────────────────────

describe("once-per-day dedup", () => {
  it("is due for a fresh user, then not due after a successful run advances the marker", async () => {
    const userId = `lr-dedup-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const row = seedLearnedRow(userId);
    expect(isLearningReviewDue(userId, NOW)).toBe(true);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () => verdictJson([{ id: row.id, table: "learned_context", verdict: "keep", confidence: 90, reasoning: "sound" }])
    });
    expect(summary.ok).toBe(true);
    expect(isLearningReviewDue(userId, NOW)).toBe(false);
    // A second same-day run skips as not-due; the next UTC day is due again.
    const again = await runDailyLearningReview(userId, { now: NOW, llm: async () => "should-not-be-called" });
    expect(again.skipped).toBe(true);
    expect(again.reason).toBe("not-due");
    expect(isLearningReviewDue(userId, NOW + 86_400_000)).toBe(true);
  });

  it("runDailyLearningReviewIfDue is a no-op when the policy flag is off", async () => {
    const userId = `lr-off-${randomUUID().slice(0, 8)}`;
    seedLearnedRow(userId);
    expect(await runDailyLearningReviewIfDue(userId, NOW)).toBeNull();
    expect(isLearningReviewDue(userId, NOW)).toBe(true); // marker untouched
  });

  it("an empty learning store terminally skips for the day (no-items)", async () => {
    const userId = `lr-empty-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const summary = await runDailyLearningReview(userId, { now: NOW, llm: async () => "should-not-be-called" });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("no-items");
    expect(isLearningReviewDue(userId, NOW)).toBe(false);
  });
});

// ── Run trigger: min-new-lessons threshold OR max-wait sweep ────────────────────

describe("review trigger (learningReviewMinNewLessons / learningReviewMaxWaitDays)", () => {
  it("stays quiet below the threshold, fires at it, and goes quiet again after a successful review", async () => {
    const userId = `lr-trigger-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const policy = getPolicy(userId);

    // One fresh lesson: below the default threshold of 5 and younger than the 7-day max wait.
    seedLearnedRow(userId);
    expect(evaluateLearningReviewTrigger(userId, NOW, policy)).toMatchObject({ shouldRun: false, newCount: 1, reason: "below-threshold" });
    // The scheduler entry point respects the trigger: no run, marker untouched.
    expect(await runDailyLearningReviewIfDue(userId, NOW)).toBeNull();
    expect(isLearningReviewDue(userId, NOW)).toBe(true);

    // Four more lessons hit the threshold.
    for (let i = 0; i < 4; i += 1) seedLearnedRow(userId);
    expect(evaluateLearningReviewTrigger(userId, NOW, policy)).toMatchObject({ shouldRun: true, newCount: 5, reason: "threshold" });

    // A successful review stores lastReviewedAt, so the same five lessons no longer count as new.
    const run = await runDailyLearningReview(userId, { now: NOW, llm: keepAllLlm() });
    expect(run.ok).toBe(true);
    expect(evaluateLearningReviewTrigger(userId, NOW + 3_600_000, policy)).toMatchObject({ shouldRun: false, reason: "no-new-items" });
  });

  it("sweeps a slow trickle once the oldest un-reviewed lesson passes the max wait", () => {
    const userId = `lr-maxage-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    // A single pending item (below the count threshold) that has waited 8 days.
    seedPendingRow(userId, { createdAt: new Date(NOW - 8 * 86_400_000).toISOString() });
    const trigger = evaluateLearningReviewTrigger(userId, NOW, getPolicy(userId));
    expect(trigger).toMatchObject({ shouldRun: true, newCount: 1, reason: "max-age" });
    expect(trigger.oldestUnreviewedAgeDays).toBeGreaterThanOrEqual(8);
  });

  it("max-age fires for a LEARNED row older than the 7-day pack window (regression: the window cutoff hid it)", async () => {
    const userId = `lr-maxage-learned-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    // A single LEARNED (not pending) lesson asserted 9 days ago — older than LEARNED_WINDOW_DAYS.
    // The trigger used to filter learned rows to the last 7 days BEFORE the max-wait test, so this
    // row dropped out of the un-reviewed count entirely: it stopped counting toward the threshold
    // and "max-age" could never fire (zero-width window at the defaults maxWaitDays == 7).
    seedLearnedRow(userId, { assertedAt: new Date(NOW - 9 * 86_400_000).toISOString() });
    const trigger = evaluateLearningReviewTrigger(userId, NOW, getPolicy(userId));
    expect(trigger).toMatchObject({ shouldRun: true, newCount: 1, reason: "max-age" });
    expect(trigger.oldestUnreviewedAgeDays).toBeGreaterThanOrEqual(9);

    // The row is outside the context-pack window, so the swept run terminally skips the day with
    // "no-items" (accepted outcome) WITHOUT advancing lastReviewedAt — the row was never reviewed,
    // so it keeps counting and re-triggers the next day rather than being silently marked reviewed.
    const swept = await runDailyLearningReview(userId, { now: NOW, llm: async () => "should-not-be-called" });
    expect(swept).toMatchObject({ skipped: true, reason: "no-items" });
    const nextDay = NOW + 86_400_000;
    expect(evaluateLearningReviewTrigger(userId, nextDay, getPolicy(userId)).reason).toBe("max-age");

    // Self-healing: once a newer lesson arrives and a review SUCCEEDS, lastReviewedAt advances past
    // the old row's assertedAt, so it stops counting/re-triggering.
    seedLearnedRow(userId);
    const run = await runDailyLearningReview(userId, { now: nextDay, llm: keepAllLlm() });
    expect(run.ok).toBe(true);
    expect(evaluateLearningReviewTrigger(userId, nextDay + 3_600_000, getPolicy(userId)).reason).toBe("no-new-items");
  });

  it("falls back to the default thresholds when stored knob values are corrupt", () => {
    const userId = `lr-corrupt-${randomUUID().slice(0, 8)}`;
    seedLearnedRow(userId);
    const corrupt = {
      ...getPolicy(userId),
      learningReviewMinNewLessons: Number.NaN,
      learningReviewMaxWaitDays: "banana" as unknown as number
    };
    // NaN knobs must not silently disable the trigger — defaults (5 / 7d) apply.
    expect(evaluateLearningReviewTrigger(userId, NOW, corrupt).reason).toBe("below-threshold");
    for (let i = 0; i < 4; i += 1) seedLearnedRow(userId);
    expect(evaluateLearningReviewTrigger(userId, NOW, corrupt)).toMatchObject({ shouldRun: true, reason: "threshold" });
  });
});

// ── Defaults + no hidden model fallback (owner 2026-07-09) ───────────────────────

describe("defaults and model requirement", () => {
  it("defaults to decide mode and the claude-fable-5 model when nothing was explicitly set", () => {
    const userId = `lr-default-${randomUUID().slice(0, 8)}`;
    const policy = getPolicy(userId);
    // "decide" is the default; only an explicit "annotate" opts out.
    expect(policy.learningReviewMode ?? "decide").not.toBe("annotate");
    // The model default is a real, explicit value — never blank-means-Fable.
    expect(policy.learningReviewModel).toBe("claude-fable-5");
  });

  it("skips with reason 'no-model' rather than silently substituting a model when blank", async () => {
    const userId = `lr-nomodel-${randomUUID().slice(0, 8)}`;
    setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewModel: "" }, userId);
    seedLearnedRow(userId);
    const summary = await runDailyLearningReview(userId, { now: NOW, llm: async () => "should-not-be-called" });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toBe("no-model");
  });
});

// ── Skip re-review when nothing changed (no wasted LLM call) ────────────────────

describe("skip unchanged sets", () => {
  it("reviews once, then skips 'unchanged' the next day on an identical set, and re-runs when a new item appears", async () => {
    const userId = `lr-unchanged-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const row = seedLearnedRow(userId);
    let calls = 0;
    const llm = async () => {
      calls += 1;
      return verdictJson([{ id: row.id, table: "learned_context", verdict: "keep", confidence: 90, reasoning: "sound" }]);
    };

    // Day 1: real review — one LLM call, fingerprint stored.
    const day1 = await runDailyLearningReview(userId, { now: NOW, llm });
    expect(day1.ok).toBe(true);
    expect(day1.skipped).toBeFalsy();
    expect(calls).toBe(1);

    // Day 2: identical item set — skip WITHOUT calling the LLM.
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm });
    expect(day2.skipped).toBe(true);
    expect(day2.reason).toBe("unchanged");
    expect(calls).toBe(1);

    // Day 3: a new learned fact appears — the set changed, so it runs again.
    seedLearnedRow(userId);
    const day3 = await runDailyLearningReview(userId, { now: NOW + 2 * 86_400_000, llm });
    expect(day3.reason).not.toBe("unchanged");
    expect(calls).toBe(2);
  });

  it("a failed review does NOT store the fingerprint, so the same set is retried the next day", async () => {
    const userId = `lr-fail-retry-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    seedLearnedRow(userId);
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("provider down");
    };
    const day1 = await runDailyLearningReview(userId, { now: NOW, llm: failing });
    expect(day1.ok).toBe(false);
    expect(day1.reason).toBe("llm-failed");
    // Next day, same set — must attempt again (not skipped as unchanged) since day 1 failed.
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm: failing });
    expect(day2.reason).toBe("llm-failed");
    expect(calls).toBe(2);
  });

  it("a mode or model change forces a fresh review of the same set instead of skipping 'unchanged'", async () => {
    const userId = `lr-config-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    seedLearnedRow(userId);
    let calls = 0;
    const llm = keepAllLlm(() => {
      calls += 1;
    });

    const day1 = await runDailyLearningReview(userId, { now: NOW, llm });
    expect(day1.ok).toBe(true);
    expect(calls).toBe(1);

    // Same set, annotate -> decide: verdicts must now be APPLIED, so the run must not skip.
    enableReview(userId, "decide");
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm });
    expect(day2.reason).not.toBe("unchanged");
    expect(day2.mode).toBe("decide");
    expect(calls).toBe(2);

    // Same set, different reviewer model: the newly chosen model must actually run.
    setPolicy({ ...getPolicy(userId), learningReviewModel: "gpt-5.5" }, userId);
    const day3 = await runDailyLearningReview(userId, { now: NOW + 2 * 86_400_000, llm });
    expect(day3.reason).not.toBe("unchanged");
    expect(calls).toBe(3);
  });

  it("does not cache the fingerprint when some shown items received no verdict (partial coverage)", async () => {
    const userId = `lr-partial-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const covered = seedLearnedRow(userId);
    seedLearnedRow(userId, { symbol: "NVDA" }); // never receives a verdict
    let calls = 0;
    const llm = async () => {
      calls += 1;
      return verdictJson([{ id: covered.id, table: "learned_context", verdict: "keep", confidence: 90, reasoning: "sound" }]);
    };

    const day1 = await runDailyLearningReview(userId, { now: NOW, llm });
    expect(day1.ok).toBe(true); // parse succeeded and the daily marker advanced...
    // ...but the uncovered item still needs a verdict: day 2 must re-attempt, not skip.
    const day2 = await runDailyLearningReview(userId, { now: NOW + 86_400_000, llm });
    expect(day2.reason).not.toBe("unchanged");
    expect(calls).toBe(2);
  });

  it("does not cache the fingerprint when a decide-mode application failed (failures are surfaced)", async () => {
    const userId = `lr-applyfail-${randomUUID().slice(0, 8)}`;
    const pending = seedPendingRow(userId);
    const pack = await buildLearningReviewContextPack(userId, NOW);
    // Poison the in-memory pending row so applyApprovedPending's insert throws mid-apply.
    pack.pendingById.set(pending.id, { ...pending, subject: undefined as unknown as string });

    const { applied, failures } = applyLearningReviewVerdicts(
      userId,
      [{ id: pending.id, table: "learned_context_pending", verdict: "keep", confidence: 90, reasoning: "sound" }],
      pack
    );

    // The failure is surfaced to the caller (the runner gates the fingerprint store on it) and audited.
    expect(failures).toBe(1);
    expect(applied).toHaveLength(0);
    expect(listAuditByKind("learning_review_apply_error", 10, userId)).toHaveLength(1);
    // The row is untouched and will be re-attempted on the next run.
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
  });
});

// ── User-level scoping: config overlays every account (the review runs once per user) ──

describe("user-level scoping", () => {
  it("learningReview settings set under one account are visible under another (user-level, not per-account)", () => {
    const userId = `lr-scope-${randomUUID().slice(0, 8)}`;
    // Set the review config while account A1 is the scope.
    setPolicy(
      { ...getPolicy(userId, "A1"), learningReviewEnabled: true, learningReviewMode: "annotate", learningReviewModel: "gpt-5.5" },
      userId,
      "A1"
    );
    // Read it back under a different account scope — user-level fields overlay every account.
    const underA2 = getPolicy(userId, "A2");
    expect(underA2.learningReviewEnabled).toBe(true);
    expect(underA2.learningReviewMode).toBe("annotate");
    expect(underA2.learningReviewModel).toBe("gpt-5.5");
  });
});

// ── User-level config must survive account removal, profile ops, and the #1116→#1278 cutover ──

describe("user-level persistence (PR #1278 review fixes)", () => {
  function seedAccount(userId: string, id: string, isActive = true) {
    upsertConnectedAccount({ id, userId, broker: "alpaca", environment: "paper", accountNumber: `PA-${id}`, label: id, isActive });
  }

  it("keeps the review config visible when the user has no active connected account (scheduler path)", () => {
    const userId = `lr-noacct-${randomUUID().slice(0, 8)}`;
    const acct = `acct-${randomUUID().slice(0, 8)}`;
    // An active library profile: its row carries stripped-to-default learningReview values
    // (setPolicy syncs it via pickAccountFields + mergePolicy), so it is the hazardous base.
    createStrategyProfile({ name: "Base", active: true }, userId);
    seedAccount(userId, acct);
    setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewModel: "gpt-5.5" }, userId);
    expect(getPolicy(userId).learningReviewEnabled).toBe(true);

    // Remove the only account: getPolicy(userId) falls back to the profile base — the user-level
    // overlay must still apply or the scheduler would read the enabled review as disabled.
    deleteConnectedAccount(acct, userId);
    const policy = getPolicy(userId);
    expect(policy.learningReviewEnabled).toBe(true);
    expect(policy.learningReviewModel).toBe("gpt-5.5");
  });

  it("activating or editing a profile does not clobber the user-level review config", () => {
    const userId = `lr-profile-${randomUUID().slice(0, 8)}`;
    const acct = `acct-${randomUUID().slice(0, 8)}`;
    seedAccount(userId, acct);
    createStrategyProfile({ name: "P1", active: true }, userId);
    const p2 = createStrategyProfile({ name: "P2", active: false }, userId);
    setPolicy({ ...getPolicy(userId), learningReviewEnabled: true, learningReviewMode: "annotate", learningReviewModel: "gpt-5.5" }, userId);

    // Activating another profile writes the full profile policy to user_settings.policy —
    // the stored user-level fields must be preserved through that write.
    activateStrategyProfile(p2.id, userId);
    const afterActivate = getPolicy(userId);
    expect(afterActivate.learningReviewEnabled).toBe(true);
    expect(afterActivate.learningReviewMode).toBe("annotate");
    expect(afterActivate.learningReviewModel).toBe("gpt-5.5");

    // Same for editing the ACTIVE profile.
    updateStrategyProfile(p2.id, { policy: { maxOrderNotional: 1234 } }, userId);
    const afterUpdate = getPolicy(userId);
    expect(afterUpdate.learningReviewEnabled).toBe(true);
    expect(afterUpdate.learningReviewModel).toBe("gpt-5.5");
    expect(afterUpdate.maxOrderNotional).toBe(1234);
  });

  it("seeds pre-cutover account-level learningReview settings into user_settings on first read", () => {
    const userId = `lr-legacy-${randomUUID().slice(0, 8)}`;
    const acct = `acct-${randomUUID().slice(0, 8)}`;
    seedAccount(userId, acct);
    // Simulate a pre-#1278 deploy: the enabled review lives ONLY in the account row's policy
    // blob (the #1116 account-scoped layout); user_settings.policy never carried the keys.
    const legacyPolicy = { ...DEFAULT_POLICY, learningReviewEnabled: true, learningReviewMode: "annotate", learningReviewModel: "gpt-5.5" };
    getDb()
      .prepare(
        `INSERT INTO account_strategy_state
           (user_id, connected_account_id, policy, prompt, scoring_weights, system_state, derived_from_profile_id, updated_at)
         VALUES (?, ?, ?, ?, ?, 'halted', NULL, ?)`
      )
      .run(userId, acct, JSON.stringify(legacyPolicy), "legacy prompt", JSON.stringify(legacyPolicy.scoringWeights), new Date().toISOString());

    // First read after the cutover: reads strip learningReview* from the account row, so the
    // lazy seed must copy the legacy values into user_settings — an already-enabled review
    // survives the deploy instead of silently disabling.
    const policy = getPolicy(userId);
    expect(policy.learningReviewEnabled).toBe(true);
    expect(policy.learningReviewMode).toBe("annotate");
    expect(policy.learningReviewModel).toBe("gpt-5.5");
    // Idempotent: the seed persisted, later reads agree.
    expect(getPolicy(userId).learningReviewEnabled).toBe(true);
  });
});

// ── Mode gating ─────────────────────────────────────────────────────────────────

describe("annotate mode", () => {
  it("records verdict + summary audits but NEVER mutates rows, even on reject verdicts", async () => {
    const userId = `lr-annotate-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "annotate");
    const learned = seedLearnedRow(userId);
    const pending = seedPendingRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () =>
        verdictJson([
          { id: learned.id, table: "learned_context", verdict: "reject", confidence: 95, reasoning: "attribution: exit deadlock active" },
          { id: pending.id, table: "learned_context_pending", verdict: "reject", confidence: 90, reasoning: "attribution" }
        ])
    });

    expect(summary.ok).toBe(true);
    expect(summary.applied).toBe(0);
    // Nothing mutated: the learned row is still live, the pending row still pending.
    expect(listLearnedContext(userId).some((r) => r.id === learned.id)).toBe(true);
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
    // Verdicts + summary are auditable.
    const verdictAudits = listAuditByKind("learning_review_verdict", 10, userId);
    expect(verdictAudits).toHaveLength(2);
    const summaryAudit = listAuditByKind("learning_review_summary", 10, userId);
    expect(summaryAudit).toHaveLength(1);
    expect((summaryAudit[0].payload as { mode: string }).mode).toBe("annotate");
    expect(listAuditByKind("learning_review_applied", 10, userId)).toHaveLength(0);
  });
});

describe("decide mode", () => {
  it("applies verdicts through the existing mutation paths, each application audited", async () => {
    const userId = `lr-decide-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const rejected = seedLearnedRow(userId);
    const expired = seedLearnedRow(userId, { symbol: "NVDA" });
    const kept = seedLearnedRow(userId, { symbol: "AAPL" });
    const pendingApproved = seedPendingRow(userId);
    const pendingRejected = seedPendingRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () =>
        verdictJson([
          { id: rejected.id, table: "learned_context", verdict: "reject", confidence: 95, reasoning: "attribution: system defect" },
          { id: expired.id, table: "learned_context", verdict: "expire", confidence: 80, reasoning: "still-true fails post-fix" },
          { id: kept.id, table: "learned_context", verdict: "keep", confidence: 85, reasoning: "sound sample" },
          { id: pendingApproved.id, table: "learned_context_pending", verdict: "keep", confidence: 75, reasoning: "sound" },
          { id: pendingRejected.id, table: "learned_context_pending", verdict: "reject", confidence: 90, reasoning: "under-sampled + defect window" }
        ])
    });

    expect(summary.ok).toBe(true);
    expect(summary.applied).toBe(4); // keep on learned_context is a no-op

    const live = listLearnedContext(userId);
    // reject → deleted
    expect(live.some((r) => r.id === rejected.id)).toBe(false);
    // expire → still stored but expires_at set, and excluded from decision reads
    const expiredRow = live.find((r) => r.id === expired.id);
    expect(expiredRow?.expiresAt).toBeTruthy();
    expect(listLearnedContextForDecision(userId, ["NVDA"]).some((r) => r.id === expired.id)).toBe(false);
    // keep → untouched
    expect(live.find((r) => r.id === kept.id)?.expiresAt).toBeNull();
    // pending keep → approved via applyApprovedPending (risk tier promotes an advisory row)
    expect(getPendingLearnedContext(pendingApproved.id, userId)?.status).toBe("approved");
    expect(live.some((r) => r.subject === pendingApproved.subject && r.riskTier === "risk")).toBe(true);
    // pending reject → rejected
    expect(getPendingLearnedContext(pendingRejected.id, userId)?.status).toBe("rejected");

    expect(listAuditByKind("learning_review_applied", 10, userId)).toHaveLength(4);
  });

  it("never mutates rows the model was not shown (unknown ids are ignored)", async () => {
    const userId = `lr-unshown-${randomUUID().slice(0, 8)}`;
    const shown = seedLearnedRow(userId);
    // A live row OUTSIDE the 7-day window — real, but not in the context pack.
    const unshown = seedLearnedRow(userId, { assertedAt: new Date(NOW - 30 * 86_400_000).toISOString() });

    const pack = await buildLearningReviewContextPack(userId, NOW);
    expect(pack.items.some((i) => i.id === shown.id)).toBe(true);
    expect(pack.items.some((i) => i.id === unshown.id)).toBe(false);

    const { applied, failures } = applyLearningReviewVerdicts(
      userId,
      [
        { id: unshown.id, table: "learned_context", verdict: "reject", confidence: 99, reasoning: "hallucinated target" },
        { id: randomUUID(), table: "learned_context_pending", verdict: "keep", confidence: 99, reasoning: "invented id" }
      ],
      pack
    );
    expect(applied).toHaveLength(0);
    expect(failures).toBe(0);
    expect(listLearnedContext(userId).some((r) => r.id === unshown.id)).toBe(true);
  });
});

describe("failure fail-safe", () => {
  it("an LLM error never mutates, audits the failure, and advances the marker (no all-day retry hammer)", async () => {
    const userId = `lr-fail-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const learned = seedLearnedRow(userId);
    const pending = seedPendingRow(userId);

    const summary = await runDailyLearningReview(userId, {
      now: NOW,
      llm: async () => {
        throw new Error("provider 500");
      }
    });

    expect(summary.ok).toBe(false);
    expect(summary.reason).toBe("llm-failed");
    expect(listLearnedContext(userId).some((r) => r.id === learned.id)).toBe(true);
    expect(getPendingLearnedContext(pending.id, userId)?.status).toBe("pending");
    expect(listAuditByKind("learning_review_failed", 10, userId)).toHaveLength(1);
    expect(listAuditByKind("learning_review_applied", 10, userId)).toHaveLength(0);
    expect(isLearningReviewDue(userId, NOW)).toBe(false);
  });

  it("unparseable model output never mutates and audits parse-failed", async () => {
    const userId = `lr-parse-${randomUUID().slice(0, 8)}`;
    enableReview(userId, "decide");
    const learned = seedLearnedRow(userId);

    const summary = await runDailyLearningReview(userId, { now: NOW, llm: async () => "this is not json" });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toBe("parse-failed");
    expect(listLearnedContext(userId).some((r) => r.id === learned.id)).toBe(true);
    const failed = listAuditByKind("learning_review_failed", 10, userId);
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { reason: string }).reason).toBe("parse-failed");
  });
});
