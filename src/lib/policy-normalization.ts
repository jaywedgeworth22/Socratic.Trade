import type { TradingPolicy } from "./types";

/**
 * The dashboard presents these risk controls as either/or knobs. Older stored
 * rows can still carry both values, which lets a hidden smaller value bind.
 * Normalize policy API writes so runtime behavior matches the visible control.
 */
export function normalizeExclusivePolicyCaps<T extends TradingPolicy>(policy: T): T {
  if (policy.maxOrderPctOfNav != null && policy.maxOrderNotional != null) {
    delete policy.maxOrderNotional;
  }
  if (policy.maxDailyNotional != null && policy.maxDailyPctOfNav != null) {
    delete policy.maxDailyPctOfNav;
  }
  if (policy.riskRules.stopLossPct != null && policy.riskRules.stopLossNotional != null) {
    delete policy.riskRules.stopLossNotional;
  }
  if (policy.riskRules.takeProfitPct != null && policy.riskRules.takeProfitNotional != null) {
    delete policy.riskRules.takeProfitNotional;
  }
  return policy;
}
