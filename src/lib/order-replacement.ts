import crypto from "crypto";
import { audit, insertFillEvent } from "./db";
import { applyPaperExitCost } from "./execution-cost";
import { deriveExecutionState, fillSourceForExecutionMode } from "./execution-mode";
import { assertLivePreflight } from "./preflight-live-guard";
import { isActiveBrokerOrderState, isRejectedOrCanceledState } from "./broker-held-orders";
import { listStaleLimitOrders } from "./stale-limit-orders";
import { normalizeSymbol } from "./money";
import type { BrokerGateway, ConnectedAccount, EquityOrder, EquityOrderInput, EquityPosition, ExecutionMode, TradingPolicy } from "./types";

const CANCEL_SETTLE_MS = 750;
const MARKET_REPLACE_TYPES = new Set(["limit", "stop_limit"]);
const POST_CANCEL_ACTIVE_STATES = new Set(["done_for_day", "stopped", "calculated"]);
const POSITION_EPSILON = 1e-6;

// Per-order cooldown for auto-remediation: once a stale EXIT limit is cancel-replaced, do not remediate
// the SAME order again for this long. A slow broker can keep listing the just-cancelled order as
// "working" past the next 60s tick; without this a second market sell would fire for the same shares
// (double-sell / accidental short). globalThis-hosted so Next.js HMR module duplication can't split it.
const REMEDIATION_COOLDOWN_MS = 5 * 60_000;
const remediationHost = globalThis as unknown as { __recentlyRemediatedExits?: Map<string, number> };
const recentlyRemediatedExits: Map<string, number> =
  remediationHost.__recentlyRemediatedExits ?? (remediationHost.__recentlyRemediatedExits = new Map<string, number>());

// In-flight replacement lock shared by BOTH the auto-remediation loop and the manual
// /api/orders/replace-market route (both funnel through replaceStaleLimitOrderWithMarket).
// A cancel-and-replace spans 1s+ (cancel + settle + refetch + review), and the manual path never
// consults the auto path's cooldown map — so a human click racing the 60s auto tick (or a
// double-click) could otherwise cancel-replace the SAME order twice: two market sells for one lot.
// Keyed by account:orderId; the entry is removed in try/finally. globalThis-hosted like the cooldown
// map above so Next.js HMR module duplication can't split it. Node is single-threaded, so the
// synchronous has()/add() pair before the first await is race-free.
const inFlightHost = globalThis as unknown as { __inFlightMarketReplaces?: Set<string> };
const inFlightMarketReplaces: Set<string> =
  inFlightHost.__inFlightMarketReplaces ?? (inFlightHost.__inFlightMarketReplaces = new Set<string>());

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
  status: "replaced" | "already_filled" | "pending_cancel";
  canceledOrderId: string;
  replacementOrderId?: string;
  brokerState?: string;
  fillStatus?: string;
  remainingQuantity: number;
}

export function marketReplaceText(symbol: string): string {
  return `REPLACE LIVE ${normalizeSymbol(symbol)}`;
}

export interface MarketReplaceInput {
  userId?: string;
  policy: TradingPolicy & { accountNumber: string };
  activeAccount?: ConnectedAccount;
  gateway: BrokerGateway;
  orderId: string;
  liveConfirmation?: MarketReplaceConfirmation;
  cancelSettleMs?: number;
}

export async function replaceStaleLimitOrderWithMarket(input: MarketReplaceInput): Promise<MarketReplaceResult> {
  // Concurrency gate: only ONE cancel-and-replace may run per order at a time, across the auto loop
  // AND the manual route. Second entrant 409s instead of double-cancelling / double-selling.
  const inFlightKey = `${input.policy.accountNumber}:${input.orderId}`;
  if (inFlightMarketReplaces.has(inFlightKey)) {
    throw new MarketReplacePreconditionError(
      "This order is already being replaced by another request (auto-remediation or a concurrent click). Wait for that replacement to finish, then refresh Activity.",
      409
    );
  }
  inFlightMarketReplaces.add(inFlightKey);
  try {
    return await executeMarketReplace(input);
  } finally {
    inFlightMarketReplaces.delete(inFlightKey);
  }
}

async function executeMarketReplace(input: MarketReplaceInput): Promise<MarketReplaceResult> {
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

  const symbol = normalizeSymbol(original.symbol);
  const isExit = original.side === "sell" || original.side === "cover";

  // Broker-HELD legs are rejected HERE, in the shared path, not only in the auto loop's skip: "held"
  // is an active state to listStaleLimitOrders, so a held bracket/OTO/OCO protective leg reaches this
  // function via the manual /api/orders/replace-market route too — and an OLD position for the same
  // symbol can satisfy the position-backed guard below (e.g. holding 100 XYZ from an old lot while a
  // new 50-share bracket entry is unfilled: 100 >= 50 passes). Cancelling the held leg destroys the
  // bracket's protection AND market-sells shares of the old lot the bracket never bought.
  if (String(original.state ?? "").trim().toLowerCase() === "held") {
    audit(
      "order_replace_market_rejected_held_leg",
      {
        orderId: original.id,
        symbol,
        side: original.side,
        state: original.state,
        orderQuantity: original.quantity,
        filledQuantity: original.filledQuantity ?? 0,
        remainingQuantity: stale.remainingQuantity
      },
      userId,
      input.policy.connectedAccountId
    );
    throw new MarketReplacePreconditionError(
      `${symbol} ${original.side} order is broker-held — a contingency leg of a bracket/OTO/OCO that activates only when its entry order fills. ` +
        "It cannot be cancel-replaced with a market order: cancelling it would destroy the entry's protection and trade shares the entry never bought. " +
        "If the trade is unwanted, cancel the ENTRY order instead. Nothing was canceled.",
      409
    );
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

  // Position-backed guard (2026-07-08 PG/T incident, PR #1036 regression): a market replacement for an
  // EXIT must be covered by a real broker position, or the "replacement" opens a naked short (sell) /
  // an unintended long (cover). Checked BEFORE the cancel phase so an unbacked order is left fully
  // intact — cancelling a bracket/OTO leg also cancels its paired entry, which is unrecoverable.
  // Broker position qty is TOTAL shares (holds reduce availability, not qty) and cancelling this order
  // releases its own hold, so total-vs-remaining is the right comparison; a residual hold from some
  // OTHER order surfaces as a broker rejection of the replacement, never as an unbacked fill.
  if (isExit) {
    const positions = await input.gateway.getEquityPositions(input.policy.accountNumber);
    const { signedQuantity, backingQuantity } = exitBackingQuantity(positions, symbol, original.side);
    if (backingQuantity + POSITION_EPSILON < stale.remainingQuantity) {
      audit(
        "stale_exit_remediation_skipped_no_position",
        {
          orderId: original.id,
          symbol,
          side: original.side,
          state: original.state,
          orderQuantity: original.quantity,
          filledQuantity: original.filledQuantity ?? 0,
          remainingQuantity: stale.remainingQuantity,
          positionQuantity: signedQuantity,
          backingQuantity,
          reason: backingQuantity <= POSITION_EPSILON ? "no_position" : "position_smaller_than_order"
        },
        userId,
        input.policy.connectedAccountId
      );
      throw new MarketReplacePreconditionError(
        `${symbol} ${original.side} order is not backed by the broker position ` +
          `(position ${signedQuantity}, order remaining ${stale.remainingQuantity}). ` +
          "Market replacement skipped; the original order was left untouched.",
        409
      );
    }
  }

  const cancelResult = await input.gateway.cancelEquityOrder(input.policy.accountNumber, original.id);
  await delay(input.cancelSettleMs ?? CANCEL_SETTLE_MS);

  const afterCancelOrders = await input.gateway.getEquityOrders(input.policy.accountNumber);
  const afterCancel = afterCancelOrders.find((order) => order.id === original.id);
  if (afterCancel && isPostCancelActiveState(afterCancel.state)) {
    audit(
      "order_replace_market_deferred_pending_cancel",
      { orderId: original.id, symbol: original.symbol, state: afterCancel.state, reason: "original_order_still_active_after_cancel", cancelResult },
      userId,
      input.policy.connectedAccountId
    );
    return { status: "pending_cancel", canceledOrderId: original.id, remainingQuantity: stale.remainingQuantity };
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

  // TOCTOU re-verify: the position-backed check above ran BEFORE the cancel phase, and 1s+ has
  // elapsed since (cancel + settle delay + order refetch). Re-verify the backing position NOW,
  // immediately before placing the market order — a concurrent fill (another exit, a short, a manual
  // trade) can shrink it in that window. If backing dropped below the remaining qty, place NOTHING:
  // the original order is already canceled and cannot be resurrected, so emit a DISTINCT receipt
  // (stale_exit_replacement_aborted_post_cancel) so the human surface explains the order is now
  // canceled-but-NOT-replaced, unlike the pre-cancel skip which leaves the order untouched.
  if (isExit) {
    const positionsNow = await input.gateway.getEquityPositions(input.policy.accountNumber);
    const { signedQuantity, backingQuantity } = exitBackingQuantity(positionsNow, symbol, original.side);
    if (backingQuantity + POSITION_EPSILON < remainingQuantity) {
      audit(
        "stale_exit_replacement_aborted_post_cancel",
        {
          orderId: original.id,
          symbol,
          side: original.side,
          remainingQuantity,
          positionQuantity: signedQuantity,
          backingQuantity,
          cancelResult,
          reason: backingQuantity <= POSITION_EPSILON ? "no_position_after_cancel" : "position_shrank_below_remaining"
        },
        userId,
        input.policy.connectedAccountId
      );
      throw new MarketReplacePreconditionError(
        `${symbol} ${original.side} replacement aborted after cancel: the backing position shrank to ${signedQuantity} ` +
          `before the market order could be placed (order remaining ${remainingQuantity}). ` +
          "The original order is now CANCELED and was NOT replaced — no market order was placed. " +
          "Review the position and place a fresh exit manually if one is still needed.",
        409
      );
    }
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
    if (isRejectedOrCanceledState(execution.state) || !execution.orderId) {
      throw new Error(`Broker immediately rejected or failed to return an order ID for the replacement order (state: ${execution.state})`);
    }
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

  const nowMs = (input.now ?? new Date()).getTime();
  // Prune expired cooldown markers so the map can't grow unbounded.
  for (const [k, t] of recentlyRemediatedExits) if (nowMs - t > REMEDIATION_COOLDOWN_MS) recentlyRemediatedExits.delete(k);

  const orders = input.orders ?? (await input.gateway.getEquityOrders(input.policy.accountNumber));
  const stale = listStaleLimitOrders(orders, input.policy, input.now ?? new Date());

  for (const item of stale) {
    const side = String(item.order.side ?? "").toLowerCase();
    if (side !== "sell" && side !== "cover") continue; // EXITS only — never force an entry to market
    // Broker-HELD legs are never stranded exits. Alpaca reports "held" only for a contingency leg the
    // broker itself is holding pending activation — the protective exit of a bracket/OTO whose ENTRY
    // has not filled, or the dormant half of an OCO — never for a plain resting exit. EquityOrder
    // carries no parent-order linkage (mapAlpacaOrder drops Alpaca's `legs`), so the held state alone
    // is the exclusion signal, and it is sufficient: the genuinely stranded exit this backstop exists
    // for (the MU deadlock) rests in an ACTIVE state ("new"/"accepted"/"partially_filled"). Cancel-
    // replacing a held leg cancels its unfilled entry AND market-sells shares that were never bought
    // (the 2026-07-08 PG -12 naked short). Silent skip like the entry-side filter above — this runs
    // every scheduler tick, and the stale-limit notifier already alerts the human on these orders.
    if (String(item.order.state ?? "").trim().toLowerCase() === "held") continue;
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
    // Double-sell guard: skip an order we already cancel-replaced within the cooldown — a slow broker
    // may still list the just-cancelled order as working, and a second market sell for the same shares
    // would flip the position short / be rejected.
    const remKey = `${input.policy.accountNumber}:${item.order.id}`;
    const lastAttempt = recentlyRemediatedExits.get(remKey);
    if (lastAttempt != null && nowMs - lastAttempt < REMEDIATION_COOLDOWN_MS) {
      audit(
        "stale_exit_auto_remediation_skipped_cooldown",
        { orderId: item.order.id, symbol, side, sinceMs: nowMs - lastAttempt },
        userId,
        input.policy.connectedAccountId
      );
      continue;
    }
    recentlyRemediatedExits.set(remKey, nowMs); // mark BEFORE the attempt — favor no-double-sell over a fast retry
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

// Shared by the pre-cancel guard and the post-cancel TOCTOU re-verify: how many shares of the broker
// position actually back this exit. A sell needs a LONG position; a cover needs a SHORT one.
function exitBackingQuantity(
  positions: EquityPosition[],
  symbol: string,
  side: EquityOrder["side"]
): { signedQuantity: number; backingQuantity: number } {
  const existing = positions.find((position) => normalizeSymbol(position.symbol) === symbol);
  const signedQuantity = existing?.quantity ?? 0;
  const backingQuantity = side === "sell" ? Math.max(signedQuantity, 0) : Math.max(-signedQuantity, 0);
  return { signedQuantity, backingQuantity };
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
