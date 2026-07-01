// G8(a) — hard per-user/day LLM budget ceiling. Extracted to its own module (from triggers.ts) so it
// can be enforced at the single choke point `runStrategyOnce` WITHOUT a strategy↔triggers import
// cycle (triggers imports runStrategyOnce from strategy). triggers.ts re-exports these for callers
// that already import from it (scheduler, tests).
import { DAILY_RESET_TIME_ZONE, startOfDayInTimeZone } from "./db";
import { getLlmUsageSummary } from "./llm-usage";

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// Both budgets are unset (0 → +Infinity ⇒ no ceiling) by default — an operator opts in by setting
// one or both. 0/negative/non-finite means "no limit" for that dimension.
function llmDailyTokenBudget(): number {
  const v = envNum("TRIGGER_LLM_DAILY_TOKEN_BUDGET", 0);
  return v > 0 ? v : Number.POSITIVE_INFINITY;
}
function llmDailyCostBudgetUsd(): number {
  const v = envNum("TRIGGER_LLM_DAILY_COST_BUDGET_USD", 0);
  return v > 0 ? v : Number.POSITIVE_INFINITY;
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
 * Hard per-user/day LLM usage ceiling. Sums TODAY's usage (America/New_York day boundary, matching
 * the daily-reset conventions in db-execution.ts) for `userId` from the ledger in llm-usage.ts across
 * every provider/context/key. Default OFF: with both TRIGGER_LLM_DAILY_TOKEN_BUDGET and
 * TRIGGER_LLM_DAILY_COST_BUDGET_USD unset, the limits are +Infinity and this always returns ok.
 * Pure + DB-read-only so it can be unit-tested directly against a seeded ledger.
 */
export function checkLlmDailyBudget(userId: string, now: Date = new Date()): LlmBudgetDecision {
  const tokenLimit = llmDailyTokenBudget();
  const costLimit = llmDailyCostBudgetUsd();
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
