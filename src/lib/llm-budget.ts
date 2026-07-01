// G8(a) — hard per-user/day LLM budget ceiling. Extracted to its own module (from triggers.ts) so it
// can be enforced at the spend primitives (withLlmGeneration, retrieveContextDetailed) and at the
// runStrategyOnce gate WITHOUT a strategy↔triggers import cycle. triggers.ts re-exports these for
// callers that already import from it (tests).
//
// CONFIG (who sets it / how to modify): the limit is a per-user POLICY setting
// (`policy.tuning.llmDailyTokenBudget` / `llmDailyCostBudgetUsd`), editable in the dashboard
// Settings → Tuning UI and via `PATCH /api/policy`. When a policy value is unset, it falls back to
// the operator env default (`TRIGGER_LLM_DAILY_TOKEN_BUDGET` / `TRIGGER_LLM_DAILY_COST_BUDGET_USD`).
// 0 / negative / unset on both = no ceiling (default OFF — behavior byte-identical).
//
// ENFORCEMENT: `checkLlmDailyBudget` is the ledger read; `isOverLlmBudget` / `assertWithinLlmBudget`
// are the guards the spend primitives call, so EVERY current and future LLM/RAG spend site is covered
// by one check rather than per-call-site gates.
import { DAILY_RESET_TIME_ZONE, getPolicy, startOfDayInTimeZone } from "./db";
import { getLlmUsageSummary } from "./llm-usage";
import type { TradingPolicy } from "./types";

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Resolve a limit: the per-user policy value when set to a positive number, else the env default,
 *  else +Infinity (no ceiling). 0 / negative anywhere means "no limit" for that dimension. */
function resolveLimit(policyValue: number | undefined, envName: string): number {
  if (typeof policyValue === "number" && Number.isFinite(policyValue) && policyValue > 0) return policyValue;
  const env = envNum(envName, 0);
  return env > 0 ? env : Number.POSITIVE_INFINITY;
}

export interface LlmBudgetDecision {
  ok: boolean;
  reason?: "token_budget" | "cost_budget";
  tokensToday?: number;
  costUsdToday?: number;
  tokenLimit?: number;
  costLimitUsd?: number;
}

/**
 * Hard per-user/day LLM usage ceiling. Reads the per-user policy limit (env fallback), then sums
 * TODAY's usage (America/New_York day boundary) for `userId` from the ledger in llm-usage.ts across
 * every provider/context/key. Default OFF: with no policy value AND no env limit, the limits are
 * +Infinity and this always returns ok. Pure + DB-read-only so it can be unit-tested directly.
 */
export function checkLlmDailyBudget(userId: string, now: Date = new Date()): LlmBudgetDecision {
  // Resilient policy read: the budget check is called from spend primitives (withLlmGeneration,
  // retrieveContextDetailed) in many contexts. If the per-user policy can't be read, degrade to the
  // env-only limit rather than throwing — never let budget bookkeeping break an LLM/RAG call.
  let tuning: TradingPolicy["tuning"];
  try {
    tuning = getPolicy(userId).tuning;
  } catch {
    tuning = undefined;
  }
  const tokenLimit = resolveLimit(tuning?.llmDailyTokenBudget, "TRIGGER_LLM_DAILY_TOKEN_BUDGET");
  const costLimit = resolveLimit(tuning?.llmDailyCostBudgetUsd, "TRIGGER_LLM_DAILY_COST_BUDGET_USD");
  if (!Number.isFinite(tokenLimit) && !Number.isFinite(costLimit)) return { ok: true };

  const dayStart = startOfDayInTimeZone(now, DAILY_RESET_TIME_ZONE);
  const rows = getLlmUsageSummary({ sinceIso: dayStart.toISOString() }).filter((r) => r.userId === userId);
  const tokensToday = rows.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
  const costUsdToday = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

  if (Number.isFinite(tokenLimit) && tokensToday >= tokenLimit) {
    return { ok: false, reason: "token_budget", tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
  }
  if (Number.isFinite(costLimit) && costUsdToday >= costLimit) {
    return { ok: false, reason: "cost_budget", tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
  }
  return { ok: true, tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
}

/** True when `userId` is at/over their daily LLM budget. Cheap wrapper used by the spend primitives. */
export function isOverLlmBudget(userId: string): boolean {
  return !checkLlmDailyBudget(userId).ok;
}

/** Thrown by `assertWithinLlmBudget` — a distinct type so callers can recognize a budget stop vs. a
 *  provider/network error. */
export class LlmBudgetExceededError extends Error {
  readonly reason?: "token_budget" | "cost_budget";
  constructor(decision: LlmBudgetDecision) {
    super(
      `Daily LLM budget ceiling reached (${decision.reason ?? "budget"}): ` +
      `tokensToday=${decision.tokensToday ?? "?"} (limit ${decision.tokenLimit ?? "∞"}), ` +
      `costUsdToday=${decision.costUsdToday ?? "?"} (limit ${decision.costLimitUsd ?? "∞"}). ` +
      `Skipping LLM/RAG spend for the rest of the day.`
    );
    this.name = "LlmBudgetExceededError";
    this.reason = decision.reason;
  }
}

/** Throw `LlmBudgetExceededError` when `userId` is over budget — the durable enforcement primitive
 *  the LLM generation wrapper calls so no model spend slips past the ceiling. No-op (returns) when
 *  under budget or no ceiling is configured. */
export function assertWithinLlmBudget(userId: string): void {
  const decision = checkLlmDailyBudget(userId);
  if (!decision.ok) throw new LlmBudgetExceededError(decision);
}
