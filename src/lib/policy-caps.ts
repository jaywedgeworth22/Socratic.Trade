import type { TradingPolicy } from "./types";

export type DailyOpeningCapMode = "pct_nav" | "dollar";

export interface DailyOpeningCap {
  mode: DailyOpeningCapMode;
  configuredValue: number;
  notional: number;
  pctOfNav?: number;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the one visible daily opening cap into dollars. Percentage mode wins
 * defensively if a legacy policy somehow carries both fields; API writes and
 * policy merges normalize the stored shape to exactly one mode.
 */
export function resolveDailyOpeningCap(
  policy: Pick<TradingPolicy, "maxDailyNotional" | "maxDailyPctOfNav">,
  portfolioValue: number | undefined
): DailyOpeningCap | undefined {
  if (positiveFinite(policy.maxDailyPctOfNav)) {
    const nav = typeof portfolioValue === "number" && Number.isFinite(portfolioValue)
      ? Math.max(0, portfolioValue)
      : 0;
    return {
      mode: "pct_nav",
      configuredValue: policy.maxDailyPctOfNav,
      notional: (policy.maxDailyPctOfNav / 100) * nav,
      pctOfNav: policy.maxDailyPctOfNav
    };
  }

  if (positiveFinite(policy.maxDailyNotional)) {
    const pctOfNav = positiveFinite(portfolioValue)
      ? (policy.maxDailyNotional / portfolioValue) * 100
      : undefined;
    return {
      mode: "dollar",
      configuredValue: policy.maxDailyNotional,
      notional: policy.maxDailyNotional,
      ...(pctOfNav !== undefined ? { pctOfNav } : {})
    };
  }

  return undefined;
}

export function effectiveDailyOpeningNotionalCap(
  policy: Pick<TradingPolicy, "maxDailyNotional" | "maxDailyPctOfNav">,
  portfolioValue: number | undefined
): number {
  return resolveDailyOpeningCap(policy, portfolioValue)?.notional ?? Infinity;
}
