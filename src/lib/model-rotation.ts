// model-rotation.ts — the "__rotate__" comparative-measurement option: rotate the Proposer (green) and/or
// Reviewer (red) model through the eligible curated models, one per strategy run, weighted toward
// models underrepresented in this account's own recent rotation history.
//
// PURPOSE (owner request 2026-07-08): accrue attributed comparative history across models on the
// selected broker account. Proposals already persist `proposedByModel` (the CONCRETE serving model),
// so attribution is automatic — rotation only has to vary which model serves each run.
//
// REASONING EFFORT (per-team split 2026-07-10): a rotating seat has NO manual effort control —
// each rotated model is served at its curated recommended reasoning effort (unknown -> "medium";
// src/lib/model-reasoning-recommendations.ts), carried on the same run-scoped override as the
// model pick (green -> llmReasoningEffort, red -> redTeamReasoningEffort) and recorded on the
// `model_rotation_pick` audit. The persisted per-team efforts are untouched.
//
// HOW IT RESOLVES: `runStrategyOnce` calls `resolveModelRotationForRun` at the TOP of every run,
// BEFORE any budget preview or `resolveLlmEndpoint` call, and merges the result onto its
// RUN-SCOPED policy clone (`runPolicy`) — the same pattern as the usage-budget downgrade. The
// PERSISTED policy keeps the sentinel so the NEXT run rotates again; nothing downstream (endpoint
// resolution, timeouts, `proposedByModel` stamping) ever sees "__rotate__". A safety net in
// `resolveOpenAiModel` (llm-request.ts) covers consumers that read the persisted policy outside a
// run (chat, lesson pass, tuning): they fail closed, never serving the literal sentinel.
//
// REPRESENTATION-WEIGHTED PICK (owner request 2026-08-06 — replaces the per-seat round-robin
// counters): each rotating seat SAMPLES its model from the eligible pool, weighted by how
// underrepresented each candidate is in this (user, account, seat)'s own recent rotation history —
// the committed `model_rotation_pick` audits over the trailing 30 days. Candidates whose
// representation count is BELOW the median of the candidate set carry weight 2 (zero-usage models
// always do — they are maximally underrepresented); at-or-above-median candidates carry weight 1.
// An underrepresented model is therefore twice as likely to be picked as an overrepresented one,
// which can still be picked. When BOTH seats rotate, a run never serves the SAME model to both:
// red samples from the pool minus green's pick (pool >= 2 only — a 1-model pool degenerates to
// same-model by necessity). The RNG is injectable (`random` on the input) so tests stay
// deterministic. The pick audit is
// COMMITTED LATE: `resolveModelRotationForRun` computes the picks early (so the budget preview can
// price the concrete models) but returns a `commit()` the caller only invokes once the run is
// actually committed to serving the LLM — after account validation and the usage-budget skip gate.
// The committed audit IS the representation ledger, so a run that aborts earlier writes nothing
// and never skews the weights with a pick that generated no proposal (no `proposedByModel` to
// match). Per-account run locks serialize same-account runs, so the read-early / commit-late
// window has no TOCTOU. Legacy `model_rotation:<userId>:<accountId>:<seat>` internal-settings
// pointer rows are no longer read or written (account-deletion cleanup still recognizes the
// prefix for old rows).
import { audit, getDb, resolveLlmCredential } from "./db";
import { modelCredentialService } from "./llm-provider";
import { isModelRotationSentinel, LLM_MODEL_ROTATION_SENTINEL } from "./llm-request";
import { recommendedReasoningEffortForModel } from "./model-reasoning-recommendations";
import { getOpenRouterUserModelAvailability, isOpenRouterModelAvailable } from "./openrouter-model-availability";
import type { LlmReasoningEffort } from "./types";

export { isModelRotationSentinel, LLM_MODEL_ROTATION_SENTINEL };

/**
 * The rotation pool: the curated model catalog (keep in sync with
 * app/ui/llm-model-catalog.ts CURATED_LLM_MODEL_GROUPS — src/lib must not import from app/)
 * MINUS deliberate exclusions:
 *   - mistral-small-2603 / mistral-medium-3-5 — RE-ADDED 2026-07-10 (owner directive: keep
 *     both in for now, pull out later if warranted). The capability map that 400'd every call
 *     (benchmark 2026-07-08, 0/12) was fixed 2026-07-09, and the 2026-07-10 keyed re-benchmark
 *     confirmed both complete real calls: small-2603 proposes cleanly (100% schema-valid,
 *     bracket-covered, cheap/fast); medium-3-5 at the pool's default effort (reasoning off)
 *     answers with an empty proposal list every round (model judgment, not a request-shape
 *     bug — see docs/rollouts/2026-07-10-mistral-rebench.md) but its reasoning tier does
 *     propose when explicitly requested at higher cost/latency.
 *   - grok-build-0.1 — coding specialist, soft-timeouts as a Green strategist.
 * Order interleaves providers so consecutive runs hit different providers even before the
 * credential filter, and so green/red (offset by the wrap-advance) pair across providers.
 */
/**
 * Catalog ids whose OpenRouter wire slugs 404 today (`moonshotai/kimi-latest`,
 * `anthropic/claude-fable-latest`).  When /models/user is reachable they are
 * already skipped.  When it times out we still must not serve them.
 */
export const DEAD_OPENROUTER_ROTATION_MODELS: readonly string[] = [
  "kimi-latest",
  "claude-fable-5"
];

export function isDeadOpenRouterRotationModel(model: string): boolean {
  return DEAD_OPENROUTER_ROTATION_MODELS.includes(model);
}

/** Credential pool after dropping known-dead slugs. Used when /models/user is down. */
export function applyRotationAvailabilityFailOpen(credentialPool: readonly string[]): string[] {
  return credentialPool.filter((model) => !isDeadOpenRouterRotationModel(model));
}

export const MODEL_ROTATION_POOL: readonly string[] = [
  "gpt-5.6-terra",
  "claude-haiku-4.5",
  "gemini-flash-latest",
  "deepseek-v4-flash",
  "mistral-small-latest",
  "gpt-5.6-luna",
  "claude-sonnet-5",
  "gemini-flash-lite-latest",
  "grok-4.5",
  "gpt-5.4-mini",
  "claude-opus-5",
  "gemini-pro-latest",
  "deepseek-v4-pro",
  "mistral-medium-latest",
  "gpt-5.6-sol",
  "gpt-5.4-nano",
  "claude-fable-5",
  "kimi-latest",
  "gpt-4o",
  "llama-3.3-70b-instruct",
  "deepseek-reasoner"
];

/** Owner request (2026-08-06, verbatim intent): a model UNDERREPRESENTED in the rotation's own
 *  statistics is twice as likely to be picked as an overrepresented one — which can still be
 *  picked (weight 1, never 0). */
export const ROTATION_UNDERREPRESENTED_WEIGHT = 2;
export const ROTATION_REPRESENTED_WEIGHT = 1;
/**
 * When the Green seat is rotating and the owner has not configured `llmFallbackModels`,
 * append this many other eligible pool models as implicit failover for empty/malformed
 * HTTP-200s (issue #2577).  Rotation otherwise serves one model per run, so a glitching
 * pick used to kill the whole run.  Cap stays small — a credits-exhausted session must
 * not fan out across the full catalog.
 */
export const ROTATION_IMPLICIT_GREEN_FAILOVERS = 2;

/** Other rotation-pool models to try after a rotating Green primary, excluding the pick
 *  and any owner-configured fallbacks.  Order follows the curated pool (provider-interleaved). */
export function implicitGreenRotationFallbacks(
  pool: readonly string[],
  primary: string,
  explicit: readonly string[] = []
): string[] {
  const taken = new Set([primary, ...explicit].map((m) => m.trim()).filter(Boolean));
  return pool.filter((model) => !taken.has(model)).slice(0, ROTATION_IMPLICIT_GREEN_FAILOVERS);
}
/** Trailing window for representation counts — safely inside the 90-day audit_events retention
 *  (`model_rotation_pick` is not an observability-pruned kind; src/lib/audit-prune.ts). */
export const ROTATION_REPRESENTATION_WINDOW_DAYS = 30;

/**
 * Pure weighting rule (unit-testable without a DB): weight 2 for candidates whose representation
 * count is BELOW the median of the candidate set, weight 1 at-or-above. Zero-usage models are
 * maximally underrepresented and ALWAYS get weight 2 — even when at/above a zero median (e.g.
 * counts [0, 0, 5]: median 0, but the two unserved models must still be favored). Empty stats
 * (all zero) degrade to uniform weight 2 across the board — i.e. uniform sampling.
 */
export function rotationRepresentationWeights(
  pool: readonly string[],
  counts: ReadonlyMap<string, number>
): number[] {
  const observed = pool.map((model) => {
    const count = counts.get(model);
    return typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  });
  if (observed.length === 0) return [];
  const sorted = [...observed].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return observed.map((count) =>
    count === 0 || count < median ? ROTATION_UNDERREPRESENTED_WEIGHT : ROTATION_REPRESENTED_WEIGHT
  );
}

/** One seat's weighted pick: the model served this run plus the weighting receipts for the audit. */
export interface WeightedRotationPick {
  model: string;
  /** Weight the sampled model carried (2 = underrepresented, 1 = at/above the median). */
  weight: number;
  /** The model's representation count in the window (committed picks for this user/account/seat). */
  representation: number;
}

/**
 * Proportional (weighted) sampling over the pool. `random()` must return a value in [0, 1) —
 * injectable so tests are deterministic; callers default it to Math.random. Out-of-range or
 * non-finite RNG output is clamped defensively rather than thrown.
 */
export function weightedRotationPick(input: {
  pool: readonly string[];
  counts: ReadonlyMap<string, number>;
  random: () => number;
}): WeightedRotationPick | undefined {
  const { pool, counts } = input;
  if (pool.length === 0) return undefined;
  const weights = rotationRepresentationWeights(pool, counts);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = input.random();
  const r = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1 - Number.EPSILON) : 0;
  let cumulative = 0;
  for (let i = 0; i < pool.length; i++) {
    cumulative += weights[i]!;
    if (r * total < cumulative) {
      return { model: pool[i]!, weight: weights[i]!, representation: counts.get(pool[i]!) ?? 0 };
    }
  }
  // Unreachable with a clamped r (< 1 guarantees r * total < total = final cumulative), kept as a
  // belt-and-braces floor so a floating-point edge can never yield "no pick" on a non-empty pool.
  const last = pool.length - 1;
  return { model: pool[last]!, weight: weights[last]!, representation: counts.get(pool[last]!) ?? 0 };
}

/**
 * The rotation pool restricted to models whose provider credential actually RESOLVES for this
 * user (their own key or the operator failover) — rotation must never inject a guaranteed-failure
 * run by picking a model nobody holds a key for.
 */
export interface EligibleRotationPool {
  pool: string[];
  skipped: string[];
  availability: "checked" | "not_checked" | "unavailable";
  availabilityError?: string;
}

export async function eligibleRotationPool(userId: string): Promise<EligibleRotationPool> {
  const pool: string[] = [];
  const skipped: string[] = [];
  const isTest = process.env.NODE_ENV === "test";
  const credentialPool: string[] = [];
  for (const model of MODEL_ROTATION_POOL) {
    // Gate on the SAME credential resolveLlmEndpoint uses to serve each model — the OpenRouter key
    // in production (an OpenRouter-only account must get the full curated pool, not an empty one),
    // the native family under NODE_ENV=test (keeps native-key fixtures working). #1703 follow-up.
    if (resolveLlmCredential(modelCredentialService(model), userId).key) credentialPool.push(model);
    else skipped.push(model);
  }
  if (credentialPool.length === 0 || isTest) return { pool: credentialPool, skipped, availability: "not_checked" };

  const credential = resolveLlmCredential("openrouter", userId);
  if (!credential.key) {
    // Native-key pool already filtered.  Do not empty it just because OpenRouter is unused.
    return { pool: credentialPool, skipped, availability: "not_checked" };
  }
  const availability = await getOpenRouterUserModelAvailability(credential.key, credential.keyRef);
  if (availability.status === "unavailable") {
    // Fail OPEN to the credential-filtered pool so a /models/user timeout or 429 cannot
    // wipe rotation (that aborted every scheduled run on 2026-08-13).  Still drop catalog
    // ids whose OpenRouter wire slugs have 404'd (kimi-latest, claude-fable-latest) —
    // serving those is how fail-open became "empty rotation seats" on 2026-08-13/14.
    const safe = applyRotationAvailabilityFailOpen(credentialPool);
    const dead = credentialPool.filter((model) => isDeadOpenRouterRotationModel(model));
    return {
      pool: safe,
      skipped: [...skipped, ...dead],
      availability: "unavailable",
      availabilityError: availability.reason
    };
  }
  if (availability.status === "available") {
    for (const model of credentialPool) {
      if (isOpenRouterModelAvailable(model, availability.modelIds)) pool.push(model);
      else skipped.push(model);
    }
    return { pool, skipped, availability: "checked" };
  }
  return { pool: credentialPool, skipped, availability: "not_checked" };
}

/**
 * Representation counts for one rotating seat: committed `model_rotation_pick` audits for the same
 * (user, account, seat) over the trailing window, keyed by model and seeded with 0 for every pool
 * candidate. Picks of models outside the current candidate pool are ignored — a model that left
 * the pool must not shift the median for the models still in it. Stats are ADVISORY: on any read
 * error the seat degrades to uniform sampling (all-zero counts) rather than failing the rotation —
 * a pick must not die because its history could not be read.
 */
function rotationSeatRepresentation(
  userId: string,
  accountId: string | undefined,
  seat: "green" | "red",
  pool: readonly string[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const model of pool) counts.set(model, 0);
  try {
    const since = new Date(Date.now() - ROTATION_REPRESENTATION_WINDOW_DAYS * 24 * 3600_000).toISOString();
    const rows = getDb()
      .prepare(
        `SELECT payload FROM audit_events
         WHERE kind = 'model_rotation_pick' AND user_id = ? AND connected_account_id IS ? AND created_at >= ?`
      )
      .all(userId, accountId ?? null, since) as Array<{ payload: string }>;
    for (const row of rows) {
      try {
        const pick = JSON.parse(row.payload) as { seat?: unknown; model?: unknown };
        if (pick.seat !== seat || typeof pick.model !== "string" || !counts.has(pick.model)) continue;
        counts.set(pick.model, (counts.get(pick.model) ?? 0) + 1);
      } catch {
        // An unparseable audit payload never breaks a pick.
      }
    }
  } catch (error) {
    console.warn(`[model-rotation] representation read failed for seat ${seat}; sampling uniformly:`, error);
  }
  return counts;
}

/**
 * Resolve the rotation sentinel(s) on a policy into CONCRETE models for one strategy run, and return
 * a `commit()` that PERSISTS the side effect (the `model_rotation_pick` audit — which doubles as the
 * representation ledger the NEXT run's weights are computed from). Each rotating seat samples its
 * model representation-weighted (see `rotationRepresentationWeights`): models underrepresented in
 * this (user, account, seat)'s committed rotation history over the trailing window are twice as
 * likely to be picked as at/above-median ones, which can still be picked. The picks are computed
 * EARLY so the caller's budget preview can reason about the concrete models this run would serve,
 * but the audit is only written when `commit()` is called — the caller invokes it once the run is
 * actually committed to serving the LLM (AFTER account validation + the usage-budget skip gate,
 * immediately before the Green proposeTrades call). A run that aborts before that writes nothing, so
 * an aborted run never skews the representation weights nor logs a phantom pick with no
 * `proposedByModel` to match (Finding 3). `commit` is ALWAYS present (a no-op when neither seat
 * rotates, on an empty eligible pool, or on any storage error). Never throws: an empty credential
 * pool or storage error resolves the rotating seats to "" (the normal unconfigured/fail-closed
 * state under no-defaults) rather than letting the raw sentinel reach a provider. An OpenRouter
 * availability timeout/429 no longer empties a non-empty credential pool. `random` is injectable
 * for deterministic tests and defaults to Math.random.
 */
export async function resolveModelRotationForRun(input: {
  userId: string;
  accountId?: string;
  runId: string;
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null };
  random?: () => number;
}): Promise<{
  llmModel?: string;
  redTeamLlmModel?: string;
  /** A rotating GREEN seat also auto-sets the served model's curated recommended reasoning effort
   *  (unknown model -> "medium"; src/lib/model-reasoning-recommendations.ts) onto the run-scoped
   *  policy — there is no manual effort control under rotation. Clamped per model at call time. */
  llmReasoningEffort?: LlmReasoningEffort;
  /** Same auto-set for a rotating RED seat (the reviewer's own per-team effort field). */
  redTeamReasoningEffort?: LlmReasoningEffort;
  /** Set when a rotating GREEN/RED seat resolved to "" so the run can show the honest message. */
  emptyReason?: "empty_pool" | "availability_unavailable";
  /** Eligible Green rotation pool for this user (credential-filtered).  Present only when the
   *  Green seat is rotating and the pool is non-empty — used to append implicit failover
   *  models when `llmFallbackModels` is unset (issue #2577). */
  greenRotationPool?: string[];
  commit: () => void;
}> {
  const rotateGreen = isModelRotationSentinel(input.policy.llmModel);
  const rotateRed = isModelRotationSentinel(input.policy.redTeamLlmModel);
  if (!rotateGreen && !rotateRed) return { commit: () => {} };
  try {
    const { pool, skipped, availability, availabilityError } = await eligibleRotationPool(input.userId);
    if (pool.length === 0) {
      // No provider credential resolves at all — no eligible model to rotate to. Under no-defaults
      // (owner 2026-07-07: DEFAULT_OPENAI_MODEL removed) there is nothing to substitute, so resolve
      // the rotating seat(s) to "" — the SAME unconfigured/fail-closed state any model-less policy
      // reaches — instead of serving the raw "__rotate__" sentinel. The run then fails closed the
      // NORMAL way (key/model precheck → actionable Settings message / route-to-human), never a
      // provider call with a bogus model id.
      const emptyReason = availability === "unavailable" ? "availability_unavailable" : "empty_pool";
      audit(
        "model_rotation_pick",
        {
          runId: input.runId,
          outcome: emptyReason,
          fallback: "",
          skipped,
          availabilityError
        },
        input.userId,
        input.accountId
      );
      return {
        ...(rotateGreen ? { llmModel: "" } : {}),
        ...(rotateRed ? { redTeamLlmModel: "" } : {}),
        emptyReason,
        commit: () => {}
      };
    }
    const random = input.random ?? Math.random;
    const greenPick = rotateGreen
      ? weightedRotationPick({
          pool,
          counts: rotationSeatRepresentation(input.userId, input.accountId, "green", pool),
          random
        })
      : undefined;
    // Same-model guarantee: when BOTH seats rotate, a run never serves green's pick to red too —
    // red samples from the pool MINUS green's model (possible only with >= 2 models; a 1-model
    // pool degenerates to same-model by necessity). Red's weights are computed over ITS candidate
    // set (the reduced pool) from RED-seat history only.
    const redPool = greenPick && pool.length >= 2 ? pool.filter((model) => model !== greenPick.model) : pool;
    const redPick = rotateRed
      ? weightedRotationPick({
          pool: redPool,
          counts: rotationSeatRepresentation(input.userId, input.accountId, "red", redPool),
          random
        })
      : undefined;
    const out: {
      llmModel?: string;
      redTeamLlmModel?: string;
      llmReasoningEffort?: LlmReasoningEffort;
      redTeamReasoningEffort?: LlmReasoningEffort;
    } = {};
    // Per-seat side effects (the pick audit = the representation ledger) are DEFERRED into `commit`:
    // the models are known now (so the budget preview can price them) but the ledger must only grow
    // once the run is committed to serving the LLM. If the caller returns/throws/skips before calling
    // commit(), nothing is audited — an aborted run never skews the weights (Finding 3).
    const commits: Array<() => void> = [];
    for (const [seat, pick] of [
      ["green", greenPick],
      ["red", redPick]
    ] as const) {
      if (!pick) continue;
      // Rotation owns the rotated seat's reasoning effort too: each served model runs at its
      // curated recommended level (unknown -> "medium"), overriding the stored per-team effort on
      // the RUN-SCOPED policy only. The persisted policy keeps the owner's stored effort for
      // whenever rotation is switched off; call time still re-clamps per model.
      const reasoningEffort = recommendedReasoningEffortForModel(pick.model, seat);
      commits.push(() => {
        audit(
          "model_rotation_pick",
          {
            runId: input.runId,
            seat,
            model: pick.model,
            reasoningEffort,
            weight: pick.weight,
            representation: pick.representation,
            poolSize: pool.length,
            skippedNoCredential: skipped
          },
          input.userId,
          input.accountId
        );
      });
      if (seat === "green") {
        out.llmModel = pick.model;
        out.llmReasoningEffort = reasoningEffort;
      } else {
        out.redTeamLlmModel = pick.model;
        out.redTeamReasoningEffort = reasoningEffort;
      }
    }
    return {
      ...out,
      ...(rotateGreen && pool.length > 0 ? { greenRotationPool: pool } : {}),
      commit: () => {
        for (const runCommit of commits) runCommit();
      }
    };
  } catch (error) {
    // Fail safe, not silent: a broken pointer store must not kill the run or leak the sentinel.
    // No-defaults (owner 2026-07-07): resolve the rotating seat(s) to "" — the normal
    // unconfigured/fail-closed state — rather than serving the raw "__rotate__" sentinel.
    console.error("[model-rotation] pick failed; failing the seat closed (no default model):", error);
    return {
      ...(rotateGreen ? { llmModel: "" } : {}),
      ...(rotateRed ? { redTeamLlmModel: "" } : {}),
      emptyReason: "empty_pool",
      commit: () => {}
    };
  }
}
