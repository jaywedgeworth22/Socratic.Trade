// Deterministic transaction-cost model for SIMULATED (paper/Test) fills.
//
// The learning loop's win-rate / average-return / edge — which then drive deterministic position
// sizing — are computed from closed lots. In Test/paper mode those lots are booked at the
// frictionless mid quote, so the loop certifies a cost-free edge that may not survive a real fill
// (half-spread + market impact), and sizes UP into exactly the thin, high-momentum names where
// live cost is worst. This model debits an estimated cost on simulated fills so the scorecards are
// net-of-cost.
//
// DEFAULT ON: with no env configured, executionCostConfig().enabled is true (1 bps base +
// sqrt market-impact), so simulated scorecards are net-of-cost by default. Opt out per box with
// PAPER_EXECUTION_COST_MODEL=off (or 0/false/no). Real broker (live) fills already carry their
// realized price and are never adjusted (no double-count) — only paper/Test fills are affected.

import type { FillSource, OrderSide } from "./types";

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
 * Default base slippage when no override is supplied (1 bps — conservative but non-zero so
 * simulated fills are net-of-cost by default without an extreme haircut).
 */
const DEFAULT_BASE_SLIPPAGE_BPS = 1;

/**
 * Read the cost-model config from env (DEFAULT ON for simulated fills).
 *
 * Enabled UNLESS `PAPER_EXECUTION_COST_MODEL` is explicitly set to a falsy value
 * ("0", "false", "off", "no"). This means:
 *   - No env → ON (default base of 1 bps + sqrt market-impact).
 *   - PAPER_EXECUTION_COST_MODEL=off → disabled (opt-out for edge cases / frictionless tests).
 *   - PAPER_EXECUTION_COST_BASE_BPS=8 → ON, overrides the default base.
 *   - PAPER_EXECUTION_IMPACT_COEFF=20 → override impact coefficient.
 *
 * Real broker (live) fills are never adjusted — only paper/simulated fills are affected.
 */
/**
 * B8 fix: apply the base execution cost to a SIMULATED (paper/test) EXIT fill priced at the raw quote.
 *
 * `recordFillFromProposal` already costs paper ENTRIES, but the two protective-exit writers
 * (`synthetic-stops.ts`, `order-replacement.ts`) insert paper/test fills at the raw price with NO cost —
 * so a paper lot exited via a synthetic stop pays no exit cost, overstating realized edge on the losing
 * tail that feeds the tuner + sizer. This applies the EXIT side's adverse adjustment (base slippage only —
 * no live scan quote is available at stop/replacement time, mirroring the entry path when spread/volume are
 * absent). LIVE fills are returned UNCHANGED (they carry a real reconciled price; double-costing would be
 * wrong), as are non-positive prices or a disabled model.
 */
export function applyPaperExitCost(price: number, side: OrderSide, source: FillSource | undefined): number {
  if (source !== "paper") return price; // "paper" covers both broker-paper and local Test simulated fills
  if (!(price > 0)) return price;
  const cfg = executionCostConfig();
  if (!cfg.enabled) return price;
  const costBps = estimateExecutionCostBps({ orderNotional: 0, baseSlippageBps: cfg.baseSlippageBps, impactCoeff: cfg.impactCoeff });
  return applyExecutionCost(price, side, costBps);
}

export function executionCostConfig(): { enabled: boolean; baseSlippageBps: number; impactCoeff: number } {
  const envFlag = String(process.env.PAPER_EXECUTION_COST_MODEL ?? "").trim().toLowerCase();
  // Explicit opt-out: treat "0", "false", "off", "no" as disabled.
  const explicitlyDisabled = ["0", "false", "off", "no"].includes(envFlag);
  const base = Number(process.env.PAPER_EXECUTION_COST_BASE_BPS);
  const coeff = Number(process.env.PAPER_EXECUTION_IMPACT_COEFF);
  const baseSlippageBps = Number.isFinite(base) && base > 0 ? base : DEFAULT_BASE_SLIPPAGE_BPS;
  const impactCoeff = Number.isFinite(coeff) && coeff > 0 ? coeff : 10;
  return { enabled: !explicitlyDisabled, baseSlippageBps, impactCoeff };
}
