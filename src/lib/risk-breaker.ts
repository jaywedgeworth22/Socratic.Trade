// Account-level circuit breaker (drawdown + daily-loss kill-switch).
//
// The per-trade/per-symbol policy gate bounds the size of any ONE mistake; it does not bound
// the account's total bleed. This module adds that missing brake: a trailing-drawdown and a
// daily-loss limit that, when breached, halt NEW entries (the caller flips systemState to
// "close_only", which still allows risk-reducing exits) and fire a kill-switch notification.
//
// `evaluateDrawdownBreaker` is pure (unit-tested in isolation). `recordAndEvaluateDrawdownBreaker`
// is the stateful wrapper: it maintains the per-account/source equity high-water mark and the
// day's starting equity in the quiet internal settings KV (no audit spam), then evaluates.

import { getInternalSetting, setInternalSetting } from "./db";
import { centralTradingDayKey } from "./trading-day";
import type { FillSource, Portfolio, RiskRules } from "./types";

export interface DrawdownBreakerInputs {
  /** Current account equity (net liquidation value). */
  equity: number;
  /** Highest equity observed since tracking began (peak). */
  highWaterMark: number;
  /** Account equity at the start of the current trading day. */
  startOfDayEquity: number;
  maxDrawdownPct?: number;
  maxDailyLossNotional?: number;
}

export interface DrawdownBreakerResult {
  breached: boolean;
  reason?: string;
}

/** Net liquidation value. Prefer the composed cash + market value; fall back to totalMarketValue. */
export function accountEquity(portfolio: Pick<Portfolio, "cash" | "equityMarketValue" | "optionMarketValue" | "totalMarketValue">): number {
  const composed = (portfolio.cash ?? 0) + (portfolio.equityMarketValue ?? 0) + (portfolio.optionMarketValue ?? 0);
  if (Number.isFinite(composed) && composed > 0) return composed;
  return portfolio.totalMarketValue ?? 0;
}

/** Pure breaker evaluation. Returns the first breach found (drawdown takes priority). */
export function evaluateDrawdownBreaker(input: DrawdownBreakerInputs): DrawdownBreakerResult {
  const { equity, highWaterMark, startOfDayEquity, maxDrawdownPct, maxDailyLossNotional } = input;

  if (maxDrawdownPct && maxDrawdownPct > 0 && highWaterMark > 0) {
    const drawdownPct = ((highWaterMark - equity) / highWaterMark) * 100;
    if (drawdownPct >= maxDrawdownPct) {
      return {
        breached: true,
        reason: `Trailing drawdown ${drawdownPct.toFixed(2)}% from the equity high-water mark $${highWaterMark.toFixed(2)} breached the ${maxDrawdownPct}% limit.`
      };
    }
  }

  if (maxDailyLossNotional && maxDailyLossNotional > 0 && startOfDayEquity > 0) {
    const dailyLoss = startOfDayEquity - equity;
    if (dailyLoss >= maxDailyLossNotional) {
      return {
        breached: true,
        reason: `Today's loss $${dailyLoss.toFixed(2)} (from start-of-day equity $${startOfDayEquity.toFixed(2)}) breached the $${maxDailyLossNotional} daily-loss limit.`
      };
    }
  }

  return { breached: false };
}

const hwmKey = (userId: string, accountNumber: string, source: FillSource) => `risk:hwm:${userId}:${accountNumber}:${source}`;
const sodKey = (userId: string, accountNumber: string, source: FillSource, day: string) => `risk:sod:${userId}:${accountNumber}:${source}:${day}`;

/**
 * Update the persisted high-water mark and day-start equity for (account, source), then evaluate
 * the breaker. The breaker only fires when the relevant riskRules limit is configured, so this is
 * a no-op for accounts that haven't opted into a circuit breaker.
 */
export function recordAndEvaluateDrawdownBreaker(args: {
  accountNumber: string;
  source: FillSource;
  equity: number;
  riskRules: RiskRules;
  userId: string;
  now?: Date;
}): DrawdownBreakerResult & { highWaterMark: number; startOfDayEquity: number } {
  const { accountNumber, source, equity, riskRules, userId } = args;
  const now = args.now ?? new Date();
  const day = centralTradingDayKey(now);

  const prevHwm = getInternalSetting<number>(hwmKey(userId, accountNumber, source));
  const highWaterMark = Math.max(Number.isFinite(prevHwm) ? (prevHwm as number) : equity, equity);
  if (highWaterMark !== prevHwm) setInternalSetting(hwmKey(userId, accountNumber, source), highWaterMark);

  let startOfDayEquity = getInternalSetting<number>(sodKey(userId, accountNumber, source, day));
  if (!Number.isFinite(startOfDayEquity)) {
    startOfDayEquity = equity;
    setInternalSetting(sodKey(userId, accountNumber, source, day), startOfDayEquity);
  }

  const result = evaluateDrawdownBreaker({
    equity,
    highWaterMark,
    startOfDayEquity: startOfDayEquity as number,
    maxDrawdownPct: riskRules.maxDrawdownPct,
    maxDailyLossNotional: riskRules.maxDailyLossNotional
  });

  return { ...result, highWaterMark, startOfDayEquity: startOfDayEquity as number };
}
