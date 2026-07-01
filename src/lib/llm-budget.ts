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
import { getRagUsageSummary } from "./rag-metering";
import type { TradingPolicy } from "./types";

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Resolve a limit for one dimension. An EXPLICIT per-user policy value always wins over the env
 *  default — including `0`, which means "no limit" (an account opting OUT of an operator-set default).
 *  Only `undefined` (blank in the UI) inherits the env default. Positive = that limit; ≤0 = no ceiling. */
function resolveLimit(policyValue: number | undefined, envName: string): number {
  if (typeof policyValue === "number" && Number.isFinite(policyValue)) {
    return policyValue > 0 ? policyValue : Number.POSITIVE_INFINITY;
  }
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
export function checkLlmDailyBudget(userId: string, now: Date = new Date(), connectedAccountId?: string): LlmBudgetDecision {
  // Resilient policy read: the budget check is called from spend primitives (withLlmGeneration,
  // retrieveContextDetailed) in many contexts. If the per-user policy can't be read, degrade to the
  // env-only limit rather than throwing — never let budget bookkeeping break an LLM/RAG call.
  // Resolve the policy for the TARGETED account (a multi-account scheduler run passes its
  // connectedAccountId) so the ceiling reflects that account's tuning, not the active account's; the
  // usage ledger is still summed per-user below. Omitting it resolves the active account (unchanged).
  let tuning: TradingPolicy["tuning"];
  try {
    tuning = getPolicy(userId, connectedAccountId).tuning;
  } catch {
    tuning = undefined;
  }
  const tokenLimit = resolveLimit(tuning?.llmDailyTokenBudget, "TRIGGER_LLM_DAILY_TOKEN_BUDGET");
  const costLimit = resolveLimit(tuning?.llmDailyCostBudgetUsd, "TRIGGER_LLM_DAILY_COST_BUDGET_USD");
  if (!Number.isFinite(tokenLimit) && !Number.isFinite(costLimit)) return { ok: true };

  const sinceIso = startOfDayInTimeZone(now, DAILY_RESET_TIME_ZONE).toISOString();
  // LLM (model) spend from the llm_usage ledger…
  const llmRows = getLlmUsageSummary({ sinceIso }).filter((r) => r.userId === userId);
  let tokensToday = llmRows.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
  let costUsdToday = llmRows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  // …PLUS RAG (Voyage/Pinecone) spend from the rag_usage ledger — the ceiling gates RAG retrieval
  // (retrieveContextDetailed), so RAG usage must count toward it too, else RAG spend never trips the
  // limit. Tokens = embed/rerank input+output; cost = estimated Voyage/Pinecone USD.
  const ragRows = getRagUsageSummary({ sinceIso }).filter((r) => r.userId === userId);
  tokensToday += ragRows.reduce((sum, r) => sum + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
  costUsdToday += ragRows.reduce((sum, r) => sum + (r.costEstUsd ?? 0), 0);

  if (Number.isFinite(tokenLimit) && tokensToday >= tokenLimit) {
    return { ok: false, reason: "token_budget", tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
  }
  if (Number.isFinite(costLimit) && costUsdToday >= costLimit) {
    return { ok: false, reason: "cost_budget", tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
  }
  return { ok: true, tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
}

/** True when `userId` is at/over their daily LLM budget. Cheap wrapper used by the spend primitives. */
export function isOverLlmBudget(userId: string, connectedAccountId?: string): boolean {
  return !checkLlmDailyBudget(userId, new Date(), connectedAccountId).ok;
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
export function assertWithinLlmBudget(userId: string, connectedAccountId?: string): void {
  const decision = checkLlmDailyBudget(userId, new Date(), connectedAccountId);
  if (!decision.ok) throw new LlmBudgetExceededError(decision);
}
