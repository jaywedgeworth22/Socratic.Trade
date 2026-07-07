import crypto from "crypto";
import { audit, insertFillEvent } from "./db";
import { applyPaperExitCost } from "./execution-cost";
import { deriveExecutionState, fillSourceForExecutionMode } from "./execution-mode";
import { assertLivePreflight } from "./preflight-live-guard";
import { isActiveBrokerOrderState } from "./broker-held-orders";
import { listStaleLimitOrders } from "./stale-limit-orders";
import { normalizeSymbol } from "./money";
import type { BrokerGateway, ConnectedAccount, EquityOrder, EquityOrderInput, ExecutionMode, TradingPolicy } from "./types";

const CANCEL_SETTLE_MS = 750;
const MARKET_REPLACE_TYPES = new Set(["limit", "stop_limit"]);
const POST_CANCEL_ACTIVE_STATES = new Set(["done_for_day", "stopped", "calculated"]);

export interface MarketReplaceConfirmation {
  orderId?: string | null;
  accountNumber?: string | null;
  executionMode?: string | null;
  remainingQuantity?: number | null;
  typedText?: string | null;
}

export class MarketReplaceConfirmationError extends Error {
  reasons: string[];
  expectedText: string;

  constructor(reasons: string[], expectedText: string) {
    super(reasons.join(" "));
    this.name = "MarketReplaceConfirmationError";
    this.reasons = reasons;
    this.expectedText = expectedText;
  }
}

export class MarketReplacePreconditionError extends Error {
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "MarketReplacePreconditionError";
    this.status = status;
  }
}

export interface MarketReplaceResult {
  status: "replaced" | "already_filled";
  canceledOrderId: string;
  replacementOrderId?: string;
  brokerState?: string;
  fillStatus?: string;
  remainingQuantity: number;
}

export function marketReplaceText(symbol: string): string {
  return `REPLACE LIVE ${normalizeSymbol(symbol)}`;
}

export async function replaceStaleLimitOrderWithMarket(input: {
  userId?: string;
  policy: TradingPolicy & { accountNumber: string };
  activeAccount?: ConnectedAccount;
  gateway: BrokerGateway;
  orderId: string;
  liveConfirmation?: MarketReplaceConfirmation;
  cancelSettleMs?: number;
}): Promise<MarketReplaceResult> {
  const userId = input.userId ?? "local";
  const executionState = deriveExecutionState(input.policy, input.activeAccount);
  if (!executionState.submitsBrokerOrders || !executionState.mode) {
    throw new MarketReplacePreconditionError("Market replacement is only available for broker-backed Paper or Brokerage accounts.", 400);
  }
  const executionMode: ExecutionMode = executionState.mode;

  const orders = await input.gateway.getEquityOrders(input.policy.accountNumber);
  const stale = listStaleLimitOrders(orders, input.policy).find((item) => item.order.id === input.orderId);
  const original = orders.find((order) => order.id === input.orderId);
  if (!original) throw new MarketReplacePreconditionError("Order was not found at the broker.", 404);
  if (!stale) {
    throw new MarketReplacePreconditionError("Order is not an active stale limit order. Refresh Activity before replacing it.", 409);
  }
  if (!MARKET_REPLACE_TYPES.has(String(original.type ?? "").toLowerCase())) {
    throw new MarketReplacePreconditionError("Only limit and stop-limit orders can be replaced with a market order here.", 400);
  }

  assertMarketReplaceConfirmation({
    executionMode,
    confirmation: input.liveConfirmation,
    order: original,
    accountNumber: input.policy.accountNumber,
    remainingQuantity: stale.remainingQuantity,
    requireTypedConfirmation: input.policy.requireTypedConfirmation !== false
  });

  // Live pre-flight BEFORE the cancel phase: this is a cancel-then-place workflow, so if the market
  // replacement would be blocked (broker/live without ALLOW_LIVE_TRADING), fail HERE — before the
  // live cancel — so we never leave the stale order cancelled with no replacement.
  assertLivePreflight({
    mode: executionMode,
    symbol: original.symbol,
    side: original.side
  });

  const cancelResult = await input.gateway.cancelEquityOrder(input.policy.accountNumber, original.id);
  await delay(input.cancelSettleMs ?? CANCEL_SETTLE_MS);

  const afterCancelOrders = await input.gateway.getEquityOrders(input.policy.accountNumber);
  const afterCancel = afterCancelOrders.find((order) => order.id === original.id);
  if (afterCancel && isPostCancelActiveState(afterCancel.state)) {
    audit(
      "order_replace_market_aborted",
      { orderId: original.id, symbol: original.symbol, state: afterCancel.state, reason: "original_order_still_active_after_cancel", cancelResult },
      userId,
      input.policy.connectedAccountId
    );
    throw new MarketReplacePreconditionError("Cancel request is still pending at the broker. Wait for cancellation before placing the market replacement.", 409);
  }

  const remainingQuantity = remainingAfterCancel(original, afterCancel);
  if (remainingQuantity <= 0) {
    audit(
      "order_replace_market_skipped",
      { orderId: original.id, symbol: original.symbol, state: afterCancel?.state, reason: "no_remaining_quantity", cancelResult },
      userId,
      input.policy.connectedAccountId
    );
    return { status: "already_filled", canceledOrderId: original.id, remainingQuantity: 0 };
  }

  const marketOrder: EquityOrderInput = {
    accountNumber: input.policy.accountNumber,
    symbol: normalizeSymbol(original.symbol),
    side: original.side,
    type: "market",
    quantity: remainingQuantity,
    timeInForce: "gfd",
    marketHours: "regular_hours"
  };
  const review = await input.gateway.reviewEquityOrder(marketOrder);
  const refId = crypto.randomUUID();
  let execution;
  try {
    execution = await input.gateway.placeEquityOrder({ ...marketOrder, refId });
  } catch (error) {
    audit(
      "order_replace_market_failed",
      {
        orderId: original.id,
        symbol: original.symbol,
        remainingQuantity,
        cancelResult,
        error: error instanceof Error ? error.message : String(error)
      },
      userId,
      input.policy.connectedAccountId
    );
    throw error;
  }

  const source = fillSourceForExecutionMode(executionState);
  const fillStatus = execution.state === "filled" ? "filled" : "pending_reconciliation";
  const rawPrice = execution.averagePrice ?? (remainingQuantity > 0 ? review.estimatedNotional / remainingQuantity : 0);
  // B8: a paper EXIT (sell/cover) booked here at the simulated mid pays no execution cost otherwise,
  // overstating realized edge on the losing tail that feeds the tuner/sizer. Debit the exit-side cost for
  // paper exits only; entries and live fills are unchanged. applyPaperExitCost no-ops on non-paper sources.
  const isExit = original.side === "sell" || original.side === "cover";
  const price = isExit ? applyPaperExitCost(rawPrice, original.side, source) : rawPrice;
  insertFillEvent({
    userId,
    accountNumber: input.policy.accountNumber,
    source,
    executionMode,
    symbol: normalizeSymbol(original.symbol),
    side: original.side,
    quantity: remainingQuantity,
    price,
    notional: Math.abs(price * remainingQuantity),
    status: fillStatus,
    brokerOrderId: execution.orderId,
    raw: {
      source: "market_replace",
      replacedOrderId: original.id,
      cancel: cancelResult,
      review,
      execution
    }
  });

  audit(
    "order_replace_market",
    {
      replacedOrderId: original.id,
      replacementOrderId: execution.orderId,
      symbol: original.symbol,
      side: original.side,
      remainingQuantity,
      brokerState: execution.state,
      fillStatus
    },
    userId,
    input.policy.connectedAccountId
  );

  return {
    status: "replaced",
    canceledOrderId: original.id,
    replacementOrderId: execution.orderId,
    brokerState: execution.state,
    fillStatus,
    remainingQuantity
  };
}

/**
 * Auto-remediate STALE EXIT limit orders by cancel-and-replacing them with a market order, so a
 * protective exit that a resting limit failed to fill cannot strand the position. This is the backstop
 * for the MU deadlock: a stale sell limit held all the shares and blocked every re-exit until the
 * broker expired it a day later. Scoped to EXITS only (sell/cover) — an unfilled ENTRY limit is the
 * owner's price discipline and is never forced to market. Respects the live typed-confirmation
 * preference: on a live account with requireTypedConfirmation on it DEFERS to the human (the stale
 * alert still fires) rather than auto-confirming a real-money market order; on paper (or live with
 * confirmation off) it remediates automatically. Opt-out via policy.autoRemediateStaleExits = false.
 */
export async function autoRemediateStaleExitOrders(input: {
  userId?: string;
  policy: TradingPolicy & { accountNumber: string };
  activeAccount?: ConnectedAccount;
  gateway: BrokerGateway;
  orders?: EquityOrder[];
  now?: Date;
}): Promise<{ remediated: number; attempted: number; deferred: number }> {
  const userId = input.userId ?? "local";
  const out = { remediated: 0, attempted: 0, deferred: 0 };
  if (input.policy.autoRemediateStaleExits === false) return out;

  const executionState = deriveExecutionState(input.policy, input.activeAccount);
  if (!executionState.submitsBrokerOrders || !executionState.mode) return out;
  const liveNeedsHuman = executionState.mode === "broker/live" && input.policy.requireTypedConfirmation !== false;

  const orders = input.orders ?? (await input.gateway.getEquityOrders(input.policy.accountNumber));
  const stale = listStaleLimitOrders(orders, input.policy, input.now ?? new Date());

  for (const item of stale) {
    const side = String(item.order.side ?? "").toLowerCase();
    if (side !== "sell" && side !== "cover") continue; // EXITS only — never force an entry to market
    const symbol = normalizeSymbol(item.order.symbol);
    if (liveNeedsHuman) {
      out.deferred++;
      audit(
        "stale_exit_auto_remediation_deferred",
        { orderId: item.order.id, symbol, side, ageMinutes: item.ageMinutes, reason: "live account with requireTypedConfirmation on — human replace required" },
        userId,
        input.policy.connectedAccountId
      );
      continue;
    }
    out.attempted++;
    try {
      const result = await replaceStaleLimitOrderWithMarket({
        userId,
        policy: input.policy,
        activeAccount: input.activeAccount,
        gateway: input.gateway,
        orderId: item.order.id
      });
      out.remediated++;
      audit(
        "stale_exit_auto_remediated",
        { orderId: item.order.id, symbol, side, ageMinutes: item.ageMinutes, status: result.status, replacementOrderId: result.replacementOrderId },
        userId,
        input.policy.connectedAccountId
      );
    } catch (err) {
      audit(
        "stale_exit_auto_remediation_failed",
        { orderId: item.order.id, symbol, side, error: err instanceof Error ? err.message : String(err) },
        userId,
        input.policy.connectedAccountId
      );
    }
  }
  return out;
}

function assertMarketReplaceConfirmation(input: {
  executionMode: ExecutionMode;
  confirmation?: MarketReplaceConfirmation;
  order: EquityOrder;
  accountNumber: string;
  remainingQuantity: number;
  requireTypedConfirmation: boolean;
}): void {
  if (input.executionMode !== "broker/live") return;
  // Owner-adjustable (policy.requireTypedConfirmation): off = one-click replace, no phrase required.
  if (!input.requireTypedConfirmation) return;
  const expectedText = marketReplaceText(input.order.symbol);
  const confirmation = input.confirmation;
  const reasons: string[] = [];
  const typedText = String(confirmation?.typedText ?? "").trim().toUpperCase();

  if (!confirmation) reasons.push("Live Brokerage market replacements require typed confirmation.");
  if (confirmation?.orderId !== input.order.id) reasons.push("Confirmation order id did not match.");
  if (confirmation?.accountNumber !== input.accountNumber) reasons.push("Confirmation account did not match.");
  if (confirmation?.executionMode !== "broker/live") reasons.push("Confirmation execution mode did not match Brokerage live.");
  if (typedText !== expectedText) reasons.push(`Type ${expectedText} to replace this live order.`);
  if (typeof confirmation?.remainingQuantity === "number" && Math.abs(confirmation.remainingQuantity - input.remainingQuantity) > 1e-6) {
    reasons.push("Confirmation remaining quantity did not match the broker order.");
  }

  if (reasons.length > 0) throw new MarketReplaceConfirmationError(reasons, expectedText);
}

function isPostCancelActiveState(state: string | undefined): boolean {
  const normalized = String(state ?? "").trim().toLowerCase();
  return isActiveBrokerOrderState(normalized) || POST_CANCEL_ACTIVE_STATES.has(normalized);
}

function remainingAfterCancel(original: EquityOrder, afterCancel?: EquityOrder): number {
  const order = afterCancel ?? original;
  const quantity = order.quantity ?? original.quantity ?? 0;
  const filledQuantity = order.filledQuantity ?? original.filledQuantity ?? 0;
  return Math.max(quantity - filledQuantity, 0);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
