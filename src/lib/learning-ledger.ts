// learning-ledger.ts — the UNIFIED learning-mutation ledger + one revert path (panel P0-4).
//
// A single append-only ledger records EVERY autonomous learning mutation (factor-weight applies today, and
// any future auto-tuning) with before/after snapshots, the subsystem, the trigger/run id, the statistical
// evidence, the flag in effect, and a timestamp. One canonical writer (`recordLearningMutation`) and one
// canonical revert (`revertLearningMutation`) — the autonomous apply path and any future nudge call these
// instead of hand-rolling audit rows or bespoke restore logic.
//
// Recording is PASSIVE/always-on (it only writes an audit trail; it changes NO trading behavior). The
// revert restores `before` via `setPolicy` ONLY (never a bespoke writer), so account_strategy_state and the
// active-profile mirror stay in sync (mirrorPolicyToActiveAccount fans out). The admin revert ROUTE is
// requireAdmin-gated (this repo has prior IDOR history) and is the only supported way to trigger a revert.
//
// This GENERALIZES the #296 tuning-specific audited revert (`auto_weight_apply` / `revertAutonomousWeight-
// Tuning`) — it does not duplicate it. `strategy-tuning.ts`'s autonomous apply now records here.

import { getPolicy, setPolicy } from "./db";
import {
  insertLearningMutation,
  latestLearningMutation,
  getLearningMutationById,
  markLearningMutationReverted,
  type LearningMutationRow
} from "./db-learning-ledger";
import type { ScoringWeights } from "./types";

/** Known learning-mutation subsystems. Extend as future auto-tuners are added. */
export const LEARNING_SUBSYSTEM_SCORING_WEIGHTS = "scoring_weights";

/** The shape of a scoring-weights before/after snapshot stored in the ledger. */
export interface ScoringWeightsSnapshot {
  scoringWeights: ScoringWeights;
}

export interface RecordLearningMutationInput {
  subsystem: string;
  userId?: string;
  connectedAccountId?: string;
  /** What fired this mutation (e.g. an audit kind, cadence key, or admin action). */
  trigger?: string;
  runId?: string;
  /** The `policy.tuning.*` flag (or other) that authorized the mutation, for the audit trail. */
  flag?: string;
  /** Full prior state (e.g. `{ scoringWeights }`) captured ATOMICALLY just before the write. */
  before: unknown;
  /** Full new state actually persisted. */
  after: unknown;
  /** OOS/statistical evidence + any thresholds/sample sizes that justified the mutation. */
  evidence?: unknown;
}

/**
 * Append one canonical learning-mutation ledger row. Passive/always-on — call this from any gated
 * autonomous mutation AFTER the state has been persisted. Returns the ledger row id.
 *
 * IMPORTANT (concurrency): the caller must capture `before` atomically — read effective policy
 * IMMEDIATELY before the persisting `setPolicy` write — or a concurrent multi-agent write records a stale
 * baseline that a later revert would wrongly restore.
 */
export function recordLearningMutation(input: RecordLearningMutationInput): string {
  return insertLearningMutation({
    userId: input.userId,
    connectedAccountId: input.connectedAccountId,
    subsystem: input.subsystem,
    trigger: input.trigger,
    runId: input.runId,
    flag: input.flag,
    beforeState: input.before,
    afterState: input.after,
    evidence: input.evidence
  });
}

export interface RevertLearningMutationResult {
  reverted: boolean;
  reason?: string;
  /** The ledger row that was reverted (present when reverted). */
  entryId?: string;
  /** The restored scoring weights (present when a scoring-weights revert succeeds). */
  restoredWeights?: ScoringWeights;
}

/** Type guard: does a ledger `before`/`after` snapshot carry a usable scoringWeights vector? */
function hasScoringWeights(state: unknown): state is ScoringWeightsSnapshot {
  return (
    typeof state === "object" &&
    state !== null &&
    "scoringWeights" in state &&
    typeof (state as { scoringWeights?: unknown }).scoringWeights === "object" &&
    (state as { scoringWeights?: unknown }).scoringWeights !== null
  );
}

/**
 * Restore a ledger entry's PRIOR state. Supports the `scoring_weights` subsystem (restores the prior
 * `ScoringWeights` vector via `setPolicy` ONLY — never a bespoke writer — so the account row and the
 * active-profile mirror stay in sync). Marks the entry reverted so the same row isn't reverted twice.
 *
 * Overloads by resolution:
 *  - `entryId` given → revert that specific row (admin picks a row);
 *  - otherwise → revert the most-recent non-reverted row for (subsystem, user, account).
 *
 * @param revertedBy identity string recorded on the row (e.g. the admin email), for the audit trail.
 */
export function revertLearningMutation(options: {
  subsystem?: string;
  userId?: string;
  connectedAccountId?: string;
  entryId?: string;
  revertedBy?: string;
}): RevertLearningMutationResult {
  const userId = options.userId ?? "local";
  const subsystem = options.subsystem ?? LEARNING_SUBSYSTEM_SCORING_WEIGHTS;

  let entry: LearningMutationRow | undefined;
  if (options.entryId) {
    entry = getLearningMutationById(options.entryId, userId);
    if (!entry) return { reverted: false, reason: "entry_not_found" };
    if (entry.revertedAt) return { reverted: false, reason: "already_reverted", entryId: entry.id };
  } else {
    entry = latestLearningMutation(subsystem, userId, options.connectedAccountId);
    if (!entry) return { reverted: false, reason: "no_prior_mutation" };
  }

  if (entry.subsystem === LEARNING_SUBSYSTEM_SCORING_WEIGHTS) {
    if (!hasScoringWeights(entry.beforeState)) {
      return { reverted: false, reason: "before_snapshot_missing_weights", entryId: entry.id };
    }
    const priorWeights = entry.beforeState.scoringWeights;
    // Restore via setPolicy on the SAME account the mutation targeted, so the active-profile mirror syncs.
    const connectedAccountId = entry.connectedAccountId || undefined;
    const policy = getPolicy(userId, connectedAccountId);
    setPolicy({ ...policy, scoringWeights: priorWeights }, userId, connectedAccountId);
    markLearningMutationReverted(entry.id, userId, options.revertedBy);
    return { reverted: true, entryId: entry.id, restoredWeights: priorWeights };
  }

  return { reverted: false, reason: `unsupported_subsystem:${entry.subsystem}`, entryId: entry.id };
}
