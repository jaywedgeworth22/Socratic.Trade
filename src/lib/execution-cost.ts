// Deterministic transaction-cost model for SIMULATED (paper/Test) fills.
//
// The learning loop's win-rate / average-return / edge — which then drive deterministic position
// sizing — are computed from closed lots. In Test/paper mode those lots are booked at the
// frictionless mid quote, so the loop certifies a cost-free edge that may not survive a real fill
// (half-spread + market impact), and sizes UP into exactly the thin, high-momentum names where
// live cost is worst. This model debits an estimated cost on simulated fills so the scorecards are
// net-of-cost.
//
// DEFAULT OFF: with no env configured, executionCostConfig().enabled is false and
// recordFillFromProposal leaves the price unchanged — existing P&L/fixtures are untouched. Real
// broker (live) fills already carry their realized price and are never adjusted (no double-count).

import type { OrderSide } from "./types";

export interface ExecutionCostInputs {
  /** (ask − bid)/mid × 1e4 — only when a real two-sided quote exists (else omitted, contributes 0). */
  spreadBps?: number;
  /** Dollar size of this fill. */
  orderNotional: number;
  /** The name's daily dollar volume (price × volume). Drives the sqrt market-impact term. */
  dollarVol?: number;
  /** Fixed slippage floor in bps. */
  baseSlippageBps: number;
  /** sqrt-impact coefficient (impactBps = coeff × sqrt(orderNotional / dollarVol)). */
  impactCoeff: number;
}

/** Total estimated round-trip-leg cost in basis points = base + half-spread + sqrt-impact. */
export function estimateExecutionCostBps(input: ExecutionCostInputs): number {
  const halfSpread = input.spreadBps && input.spreadBps > 0 ? input.spreadBps / 2 : 0;
  let impact = 0;
  if (input.impactCoeff > 0 && input.dollarVol && input.dollarVol > 0 && input.orderNotional > 0) {
    impact = input.impactCoeff * Math.sqrt(input.orderNotional / input.dollarVol);
  }
  return Math.max(0, input.baseSlippageBps + halfSpread + impact);
}

/** Adverse price adjustment: a buy/cover pays UP, a sell/short receives DOWN. */
export function applyExecutionCost(price: number, side: OrderSide, costBps: number): number {
  if (!(price > 0) || !(costBps > 0)) return price;
  const factor = costBps / 1e4;
  const paysUp = side === "buy" || side === "cover";
  return paysUp ? price * (1 + factor) : price * (1 - factor);
}

/**
 * Read the cost-model config from env (default OFF). Enabled when PAPER_EXECUTION_COST_MODEL is
 * truthy OR a positive PAPER_EXECUTION_COST_BASE_BPS is set. Impact coeff defaults to 10.
 */
export function executionCostConfig(): { enabled: boolean; baseSlippageBps: number; impactCoeff: number } {
  const flag = ["1", "true", "on", "yes"].includes(String(process.env.PAPER_EXECUTION_COST_MODEL ?? "").trim().toLowerCase());
  const base = Number(process.env.PAPER_EXECUTION_COST_BASE_BPS);
  const coeff = Number(process.env.PAPER_EXECUTION_IMPACT_COEFF);
  const baseSlippageBps = Number.isFinite(base) && base > 0 ? base : 0;
  const impactCoeff = Number.isFinite(coeff) && coeff > 0 ? coeff : 10;
  return { enabled: flag || baseSlippageBps > 0, baseSlippageBps, impactCoeff };
}
