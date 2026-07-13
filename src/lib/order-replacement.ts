import crypto from "crypto";
import { audit, insertFillEvent, getDb } from "./db";
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

export interface OrderReplacementRow {
  id: string;
  user_id: string;
  account_number: string;
  original_order_id: string;
  symbol: string | null;
  side: string | null;
  original_type: string | null;
  original_quantity: number | null;
  original_filled_quantity: number | null;
  replacement_ref_id: string;
  status: "cancel_requested" | "cancel_confirmed" | "replacement_submitted" | "replacement_confirmed" | "failed" | "aborted";
  remaining_quantity: number | null;
  cancel_result: string | null;
  replacement_order_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

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
  const userId = input.userId ?? "local";
  const db = getDb();
  
  // Concurrency guard is now enforced via SQLite UNIQUE constraint: Only one 
  // replacement state machine per (account_number, original_order_id).
  const id = crypto.randomUUID();
  const refId = crypto.randomUUID();
  const now = new Date().toISOString();
  
  const insertTx = db.transaction(() => {
    const active = db.prepare(`
      SELECT 1 FROM order_replacements
      WHERE account_number = ? AND original_order_id = ?
      AND status NOT IN ('replacement_confirmed', 'failed', 'aborted')
    `).get(input.policy.accountNumber, input.orderId);

    if (active) {
      throw new MarketReplacePreconditionError(
        "This order is already being replaced by another request (auto-remediation or a concurrent click). Wait for that replacement to finish, then refresh Activity.",
        409
      );
    }

    db.prepare(`
      INSERT INTO order_replacements 
      (id, user_id, account_number, original_order_id, replacement_ref_id, status, created_at, updated_at) 
      VALUES (?, ?, ?, ?, ?, 'cancel_requested', ?, ?)
    `).run(id, userId, input.policy.accountNumber, input.orderId, refId, now, now);
  });
  
  insertTx();

  // Initial Preconditions Check
  const executionState = deriveExecutionState(input.policy, input.activeAccount);
  if (!executionState.submitsBrokerOrders || !executionState.mode) {
    await markReplacementError(id, "Market replacement is only available for broker-backed Paper or Brokerage accounts.");
    throw new MarketReplacePreconditionError("Market replacement is only available for broker-backed Paper or Brokerage accounts.", 400);
  }
  const executionMode: ExecutionMode = executionState.mode;

  const orders = await input.gateway.getEquityOrders(input.policy.accountNumber);
  const stale = listStaleLimitOrders(orders, input.policy).find((item) => item.order.id === input.orderId);
  const original = orders.find((order) => order.id === input.orderId);
  if (!original) {
    await markReplacementError(id, "Order was not found at the broker.");
    throw new MarketReplacePreconditionError("Order was not found at the broker.", 404);
  }
  db.prepare(`
    UPDATE order_replacements 
    SET symbol = ?, side = ?, original_type = ?, original_quantity = ?, original_filled_quantity = ?
    WHERE id = ?
  `).run(original.symbol, original.side, original.type, original.quantity, original.filledQuantity ?? 0, id);
  if (!stale) {
    await markReplacementError(id, "Order is not an active stale limit order.");
    throw new MarketReplacePreconditionError("Order is not an active stale limit order. Refresh Activity before replacing it.", 409);
  }
  if (!MARKET_REPLACE_TYPES.has(String(original.type ?? "").toLowerCase())) {
    await markReplacementError(id, "Only limit and stop-limit orders can be replaced with a market order here.");
    throw new MarketReplacePreconditionError("Only limit and stop-limit orders can be replaced with a market order here.", 400);
  }

  const symbol = normalizeSymbol(original.symbol);
  
  if (String(original.state ?? "").trim().toLowerCase() === "held") {
    const errStr = `${symbol} ${original.side} order is broker-held — a contingency leg of a bracket/OTO/OCO that activates only when its entry order fills. It cannot be cancel-replaced with a market order: cancelling it would destroy the entry's protection and trade shares the entry never bought. If the trade is unwanted, cancel the ENTRY order instead. Nothing was canceled.`;
    await markReplacementError(id, errStr);
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
    throw new MarketReplacePreconditionError(errStr, 409);
  }

  try {
    assertMarketReplaceConfirmation({
      executionMode,
      confirmation: input.liveConfirmation,
      order: original,
      accountNumber: input.policy.accountNumber,
      remainingQuantity: stale.remainingQuantity,
      requireTypedConfirmation: input.policy.requireTypedConfirmation !== false
    });
  } catch (err: any) {
    await markReplacementError(id, err.message);
    throw err;
  }

  assertLivePreflight({
    mode: executionState.mode,
    symbol: original.symbol,
    side: original.side
  });
  
  let row = getReplacementRecord(id);
  const maxLoops = 10;
  let loops = 0;
  while (row && !isTerminalState(row.status) && loops < maxLoops) {
    await stepReplacementState(row, input, original);
    row = getReplacementRecord(id);
    loops++;
  }

  if (row?.status === 'replacement_confirmed') {
    // Read the actual fill status from the fill event that was created inside
    // stepReplacementState, so the caller sees "filled" for immediately-filled
    // market replacements instead of always reporting "pending_reconciliation".
    const fillEvent = db.prepare(`SELECT status FROM fill_events WHERE broker_order_id = ? ORDER BY filled_at DESC LIMIT 1`).get(row.replacement_order_id) as { status: string } | undefined;
    const fillStatus = fillEvent?.status ?? "pending_reconciliation";
    return { status: "replaced", canceledOrderId: original.id, replacementOrderId: row.replacement_order_id!, fillStatus, remainingQuantity: row.remaining_quantity! };
  } else if (row?.status === 'aborted') {
    if (row.cancel_result && row.remaining_quantity === 0) {
      return { status: "already_filled", canceledOrderId: original.id, remainingQuantity: 0 };
    }
    if (row.error) {
      throw new MarketReplacePreconditionError(row.error, 409);
    }
    return { status: "pending_cancel", canceledOrderId: original.id, remainingQuantity: stale.remainingQuantity };
  } else if (row?.status === 'failed') {
    throw new Error(row.error ?? "Replacement failed");
  } else {
    // Timeout or pending
    return { status: "pending_cancel", canceledOrderId: original.id, remainingQuantity: stale.remainingQuantity };
  }
}

async function markReplacementError(id: string, error: string) {
  getDb().prepare(`UPDATE order_replacements SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
    .run(error, new Date().toISOString(), id);
}

function getReplacementRecord(id: string): OrderReplacementRow | undefined {
  return getDb().prepare(`SELECT * FROM order_replacements WHERE id = ?`).get(id) as OrderReplacementRow | undefined;
}

function isTerminalState(status: string) {
  return status === 'replacement_confirmed' || status === 'failed' || status === 'aborted';
}

async function stepReplacementState(row: OrderReplacementRow, input: MarketReplaceInput, original?: EquityOrder) {
  const db = getDb();
  const userId = input.userId ?? "local";

  let originalOrder: EquityOrder;
  if (original) {
    originalOrder = original;
  } else {
    const orders = await input.gateway.getEquityOrders(input.policy.accountNumber);
    const found = orders.find((o) => o.id === row.original_order_id);
    if (found) {
      originalOrder = found;
    } else if (row.symbol && row.side && row.original_type && row.original_quantity !== null && row.original_filled_quantity !== null) {
      originalOrder = {
        id: row.original_order_id,
        symbol: row.symbol,
        side: row.side as any,
        type: row.original_type as any,
        quantity: row.original_quantity,
        filledQuantity: row.original_filled_quantity,
        state: "canceled",
        createdAt: row.created_at
      };
    } else {
      await markReplacementError(row.id, "Original order not found at broker during state step");
      return;
    }
  }

  const symbol = normalizeSymbol(originalOrder.symbol);
  const executionState = deriveExecutionState(input.policy, input.activeAccount);
  const executionMode: ExecutionMode = executionState.mode!;

  try {
    // Live trading preflight guard — must be checked inside the state-machine step
    // because the background pump may process a row that was enqueued before the env
    // changed (e.g. ALLOW_LIVE_TRADING set to false after the row was inserted) or
    // that was created through a path where preflight was already passed (the manual
    // wrapper) but whose execution is now being handled by the pump.
    assertLivePreflight({ mode: executionMode, symbol, side: originalOrder.side });

    if (row.status === 'cancel_requested') {
      // Re-check eligibility — order type and broker-held state may have changed
      // between enqueue time and the pump processing this row, and the pump should
      // not blindly cancel an order that is no longer eligible for replacement.
      if (!MARKET_REPLACE_TYPES.has(String(originalOrder.type ?? "").toLowerCase())) {
        const errStr = `${symbol} order type (${originalOrder.type}) is no longer eligible for market replacement.`;
        db.prepare(`UPDATE order_replacements SET status = 'aborted', error = ?, updated_at = ? WHERE id = ?`)
          .run(errStr, new Date().toISOString(), row.id);
        audit("stale_exit_remediation_skipped_type_changed", { orderId: originalOrder.id, symbol, side: originalOrder.side, type: originalOrder.type }, userId, input.policy.connectedAccountId);
        throw new MarketReplacePreconditionError(errStr, 409);
      }
      if (String(originalOrder.state ?? "").trim().toLowerCase() === "held") {
        const errStr = `${symbol} ${originalOrder.side} order is broker-held — cannot be cancel-replaced.`;
        db.prepare(`UPDATE order_replacements SET status = 'aborted', error = ?, updated_at = ? WHERE id = ?`)
          .run(errStr, new Date().toISOString(), row.id);
        audit("stale_exit_remediation_skipped_held", { orderId: originalOrder.id, symbol, side: originalOrder.side, state: originalOrder.state }, userId, input.policy.connectedAccountId);
        throw new MarketReplacePreconditionError(errStr, 409);
      }

      const isExit = originalOrder.side === "sell" || originalOrder.side === "cover";
      if (isExit) {
        const positions = await input.gateway.getEquityPositions(input.policy.accountNumber);
        const { signedQuantity, backingQuantity } = exitBackingQuantity(positions, symbol, originalOrder.side);
        const remainingQuantity = remainingAfterCancel(originalOrder);
        if (backingQuantity + POSITION_EPSILON < remainingQuantity) {
          const errStr = `${symbol} ${originalOrder.side} order is not backed by the broker position (position ${signedQuantity}, order remaining ${remainingQuantity}). Market replacement skipped; the original order was left untouched.`;
          db.prepare(`UPDATE order_replacements SET status = 'aborted', updated_at = ?, error = ? WHERE id = ?`)
            .run(new Date().toISOString(), errStr, row.id);
          audit(
            "stale_exit_remediation_skipped_no_position",
            { orderId: originalOrder.id, symbol, side: originalOrder.side, remainingQuantity, positionQuantity: signedQuantity, backingQuantity, reason: backingQuantity === 0 ? "no_position" : "position_smaller_than_order" },
            userId,
            input.policy.connectedAccountId
          );
          throw new MarketReplacePreconditionError(errStr, 409);
        }
      }

      const cancelResult = await input.gateway.cancelEquityOrder(input.policy.accountNumber, originalOrder.id);
      db.prepare(`UPDATE order_replacements SET cancel_result = ?, status = 'cancel_confirmed', updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(cancelResult), new Date().toISOString(), row.id);
      await delay(input.cancelSettleMs ?? CANCEL_SETTLE_MS);
    }
    
    // Reload row in case it changed
    row = getReplacementRecord(row.id)!;
    
    if (row.status === 'cancel_confirmed') {
      const afterCancelOrders = await input.gateway.getEquityOrders(input.policy.accountNumber);
      const afterCancel = afterCancelOrders.find((order) => order.id === originalOrder.id);
      
      const staleOrders = listStaleLimitOrders(afterCancelOrders, input.policy);
      const remainingQuantity = remainingAfterCancel(originalOrder, afterCancel);

      if (afterCancel && isPostCancelActiveState(afterCancel.state)) {
        audit(
          "order_replace_market_deferred_pending_cancel",
          { orderId: originalOrder.id, symbol, state: afterCancel.state, reason: "original_order_still_active_after_cancel", cancelResult: row.cancel_result },
          userId,
          input.policy.connectedAccountId
        );
        // We stay in cancel_confirmed and try again next tick
        return;
      }

      if (remainingQuantity <= 0) {
        audit(
          "order_replace_market_skipped",
          { orderId: originalOrder.id, symbol, state: afterCancel?.state, reason: "no_remaining_quantity", cancelResult: row.cancel_result },
          userId,
          input.policy.connectedAccountId
        );
        db.prepare(`UPDATE order_replacements SET status = 'aborted', remaining_quantity = 0, updated_at = ? WHERE id = ? AND status = 'cancel_confirmed'`)
          .run(new Date().toISOString(), row.id);
        return;
      }

      // Re-verify backing position
      const isExit = originalOrder.side === "sell" || originalOrder.side === "cover";
      if (isExit) {
        const positionsNow = await input.gateway.getEquityPositions(input.policy.accountNumber);
        const { signedQuantity, backingQuantity } = exitBackingQuantity(positionsNow, symbol, originalOrder.side);
        if (backingQuantity + POSITION_EPSILON < remainingQuantity) {
          const reason = backingQuantity <= POSITION_EPSILON ? "no_position_after_cancel" : "position_shrank_below_remaining";
          const errStr = `${symbol} ${originalOrder.side} replacement aborted after cancel: the backing position shrank to ${signedQuantity} before the market order could be placed (order remaining ${remainingQuantity}). The original order is now CANCELED and was NOT replaced — no market order was placed. Review the position and place a fresh exit manually if one is still needed.`;
          
          audit(
            "stale_exit_replacement_aborted_post_cancel",
            { orderId: originalOrder.id, symbol, side: originalOrder.side, remainingQuantity, positionQuantity: signedQuantity, backingQuantity, cancelResult: row.cancel_result, reason },
            userId,
            input.policy.connectedAccountId
          );
          db.prepare(`UPDATE order_replacements SET status = 'aborted', error = ?, remaining_quantity = ?, updated_at = ? WHERE id = ? AND status = 'cancel_confirmed'`)
            .run(errStr, remainingQuantity, new Date().toISOString(), row.id);
          return;
        }
      }

      const marketOrder: EquityOrderInput = {
        accountNumber: input.policy.accountNumber,
        symbol: symbol,
        side: originalOrder.side,
        type: "market",
        quantity: remainingQuantity,
        timeInForce: "gfd",
        marketHours: "regular_hours"
      };
      
      const review = await input.gateway.reviewEquityOrder(marketOrder);
      const casResult = db.prepare(`UPDATE order_replacements SET status = 'replacement_submitted', remaining_quantity = ?, updated_at = ? WHERE id = ? AND status = 'cancel_confirmed'`)
        .run(remainingQuantity, new Date().toISOString(), row.id);
      if (casResult.changes !== 1) {
        audit(
          "order_replace_market_claimed_by_another",
          { orderId: originalOrder.id, symbol, remainingQuantity, cancelResult: row.cancel_result, reason: "CAS update affected 0 rows — another instance claimed this cancel_confirmed row" },
          userId,
          input.policy.connectedAccountId
        );
        return;
      }

      // We placed it, transition immediately
      let execution;
      try {
        execution = await input.gateway.placeEquityOrder({ ...marketOrder, refId: row.replacement_ref_id });
      } catch (error) {
        // Stay in replacement_submitted instead of failing — the broker may have
        // accepted the market order before our connection dropped or timed out.
        // The replacement_submitted reconciliation branch looks up the broker
        // order by replacement_ref_id on the next tick; only if too much time
        // passes without finding the order will it be failed.
        audit(
          "order_replace_market_submission_ambiguous",
          { orderId: originalOrder.id, symbol, remainingQuantity, cancelResult: row.cancel_result, error: error instanceof Error ? error.message : String(error) },
          userId,
          input.policy.connectedAccountId
        );
        db.prepare(`UPDATE order_replacements SET error = ?, updated_at = ? WHERE id = ? AND status = 'replacement_submitted'`)
          .run(error instanceof Error ? error.message : String(error), new Date().toISOString(), row.id);
        return;
      }
      // placeEquityOrder returned without throwing, but the broker may have rejected it.
      if (isRejectedOrCanceledState(execution.state) || !execution.orderId) {
        const rejectStr = `Broker rejected the replacement order (state: ${execution.state})`;
        db.prepare(`UPDATE order_replacements SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
          .run(rejectStr, new Date().toISOString(), row.id);
        audit(
          "order_replace_market_rejected",
          { orderId: originalOrder.id, symbol, remainingQuantity, cancelResult: row.cancel_result, brokerState: execution.state },
          userId,
          input.policy.connectedAccountId
        );
        return;
      }

      const source = fillSourceForExecutionMode(executionState);
      const fillStatus = execution.state === "filled" ? "filled" : "pending_reconciliation";
      const rawPrice = execution.averagePrice ?? (remainingQuantity > 0 ? review.estimatedNotional / remainingQuantity : 0);
      const price = isExit ? applyPaperExitCost(rawPrice, originalOrder.side, source) : rawPrice;
      insertFillEvent({
        userId,
        accountNumber: input.policy.accountNumber,
        source,
        executionMode,
        symbol,
        side: originalOrder.side,
        quantity: remainingQuantity,
        price,
        notional: Math.abs(price * remainingQuantity),
        status: fillStatus,
        brokerOrderId: execution.orderId,
        raw: {
          source: "market_replace",
          replacedOrderId: originalOrder.id,
          cancel: row.cancel_result,
          review,
          execution
        }
      });

      // Mark the row terminal AFTER the fill is recorded so a crash between the
      // status update and fill insertion doesn't leave a terminal row with no fill.
      db.prepare(`UPDATE order_replacements SET status = 'replacement_confirmed', replacement_order_id = ?, updated_at = ? WHERE id = ?`)
        .run(execution.orderId, new Date().toISOString(), row.id);

      audit(
        "order_replace_market",
        {
          replacedOrderId: originalOrder.id,
          replacementOrderId: execution.orderId,
          symbol,
          side: originalOrder.side,
          remainingQuantity,
          brokerState: execution.state,
          fillStatus
        },
        userId,
        input.policy.connectedAccountId
      );
    }

    if (row.status === 'replacement_submitted') {
      const isExit = originalOrder.side === "sell" || originalOrder.side === "cover";
      const orders = await input.gateway.getEquityOrders(input.policy.accountNumber);
      const found = orders.find((o) => o.clientOrderId === row.replacement_ref_id || o.id === row.replacement_order_id);
      if (found) {
        // Treat terminal (rejected/canceled) broker states as failures so the
        // state machine stops retrying and the original exit remains canceled
        // with no replacement — the caller will see a failed row and can alert.
        if (isRejectedOrCanceledState(found.state)) {
          db.prepare(`UPDATE order_replacements SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
            .run(`Replacement order was ${found.state} by the broker`, new Date().toISOString(), row.id);
          return;
        }
        // Already placed, confirm it
        db.prepare(`UPDATE order_replacements SET status = 'replacement_confirmed', replacement_order_id = ?, updated_at = ? WHERE id = ?`)
          .run(found.id, new Date().toISOString(), row.id);

        // Check if fill event exists for this order
        const fillExists = db.prepare(`SELECT 1 FROM fill_events WHERE broker_order_id = ?`).get(found.id);
        if (!fillExists) {
          const source = fillSourceForExecutionMode(executionState);
          // If averagePrice is missing from a filled order, keep the fill as
          // pending_reconciliation so normal pending-fill reconciliation can
          // fill in the price later — a zero-price booked fill would never
          // be revisited and would skew P&L.
          const fillStatus = found.state === "filled" && found.averagePrice != null ? "filled" : "pending_reconciliation";
          const rawPrice = found.averagePrice ?? 0;
          const price = isExit ? applyPaperExitCost(rawPrice, originalOrder.side, source) : rawPrice;
          insertFillEvent({
            userId,
            accountNumber: input.policy.accountNumber,
            source,
            executionMode,
            symbol,
            side: originalOrder.side,
            quantity: row.remaining_quantity!,
            price,
            notional: Math.abs(price * row.remaining_quantity!),
            status: fillStatus,
            brokerOrderId: found.id,
            raw: {
              source: "market_replace_reconciliation",
              replacedOrderId: originalOrder.id,
              cancel: row.cancel_result,
              order: found
            }
          });
        }
        return;
      } else {
        // Not found at broker. Check if a fill event exists for this replacement_ref_id or replacement_order_id.
        const fillExists = db.prepare(`SELECT 1 FROM fill_events WHERE broker_order_id = ? OR raw LIKE ?`)
          .get(row.replacement_order_id, `%${row.replacement_ref_id}%`);
        if (fillExists) {
          db.prepare(`UPDATE order_replacements SET status = 'replacement_confirmed', updated_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), row.id);
          return;
        }

        // If not found and no fill exists, and it's been in 'replacement_submitted' status for some time (e.g. > 5 minutes),
        // we assume the submission failed to reach the broker, and mark it failed.
        const ageMs = Date.now() - new Date(row.updated_at).getTime();
        if (ageMs > 5 * 60_000) {
          const errStr = "Replacement order submission timed out or failed to reach the broker.";
          // Only fail if the row is still in replacement_submitted — a peer may have
          // already reconciled it to replacement_confirmed.
          db.prepare(`UPDATE order_replacements SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'replacement_submitted'`)
            .run(errStr, new Date().toISOString(), row.id);
          audit("stale_exit_replacement_submission_failed", { orderId: originalOrder.id, symbol, refId: row.replacement_ref_id }, userId, input.policy.connectedAccountId);
        }
        return;
      }
    }
  } catch (e: any) {
     if (e instanceof MarketReplacePreconditionError) throw e;
     switch (row.status) {
       case 'cancel_requested':
         // Conditionally fail only if we still own the state. If a peer already
         // transitioned us to cancel_confirmed, the conditional WHERE clause
         // means the update hits 0 rows and the row stays in its advanced state.
         db.prepare(`UPDATE order_replacements SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'cancel_requested'`)
           .run(e.message, new Date().toISOString(), row.id);
         break;
       case 'cancel_confirmed':
         // Keep retriable — the order is already canceled; a transient error
         // (network blip, broker timeout) after the cancel shouldn't lose the
         // replacement. The pump will retry on the next tick.
         db.prepare(`UPDATE order_replacements SET error = ?, updated_at = ? WHERE id = ?`)
           .run(e.message, new Date().toISOString(), row.id);
         break;
       default:
         // Only fail replacement_submitted rows — if a peer already advanced
         // this row to replacement_confirmed don't regress it to failed.
         db.prepare(`UPDATE order_replacements SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'replacement_submitted'`)
           .run(e.message, new Date().toISOString(), row.id);
     }
  }
}

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
  const db = getDb();

  const executionState = deriveExecutionState(input.policy, input.activeAccount);
  if (!executionState.submitsBrokerOrders || !executionState.mode) return out;
  const liveNeedsHuman = executionState.mode === "broker/live" && input.policy.requireTypedConfirmation !== false;

  // Enqueue new replacements only if auto mode is enabled
  if (input.policy.autoRemediateStaleExits !== false) {
    const orders = input.orders ?? (await input.gateway.getEquityOrders(input.policy.accountNumber));
    const stale = listStaleLimitOrders(orders, input.policy, input.now ?? new Date());

    for (const item of stale) {
      const side = String(item.order.side ?? "").toLowerCase();
      if (side !== "sell" && side !== "cover") continue;
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
      
      // Use a transaction for check-and-insert
      const insertTx = db.transaction(() => {
        const fiveMinsAgo = new Date(Date.now() - 5 * 60_000).toISOString();
        const activeOrRecent = db.prepare(`
          SELECT 1 FROM order_replacements
          WHERE account_number = ? AND original_order_id = ?
          AND (
            status NOT IN ('replacement_confirmed', 'failed', 'aborted')
            OR updated_at > ?
          )
        `).get(input.policy.accountNumber, item.order.id, fiveMinsAgo);

        if (!activeOrRecent) {
          const id = crypto.randomUUID();
          const refId = crypto.randomUUID();
          const now = new Date().toISOString();
          return db.prepare(`
            INSERT INTO order_replacements 
            (id, user_id, account_number, original_order_id, symbol, side, original_type, original_quantity, original_filled_quantity, replacement_ref_id, status, created_at, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cancel_requested', ?, ?)
          `).run(id, userId, input.policy.accountNumber, item.order.id, item.order.symbol, item.order.side, item.order.type, item.order.quantity, item.order.filledQuantity ?? 0, refId, now, now);
        }
        return { changes: 0 };
      });
      
      const result = insertTx();
      
      if (result.changes > 0) {
        out.attempted++;
      }
    }
  }

  // Pump all active state machines for this account
  const activeReplacements = db.prepare(`SELECT * FROM order_replacements WHERE user_id = ? AND account_number = ? AND status IN ('cancel_requested', 'cancel_confirmed', 'replacement_submitted')`)
    .all(userId, input.policy.accountNumber) as OrderReplacementRow[];

  for (const row of activeReplacements) {
    try {
      await stepReplacementState(row, {
        userId,
        policy: input.policy,
        activeAccount: input.activeAccount,
        gateway: input.gateway,
        orderId: row.original_order_id
      });
    } catch (e: any) {
      if (e instanceof MarketReplacePreconditionError) {
        audit("stale_exit_auto_remediation_failed", { orderId: row.original_order_id, reason: "precondition_failed", details: e.message }, userId, input.policy.connectedAccountId);
      } else {
        console.error(`autoRemediateStaleExitOrders unexpected error for row ${row.id}:`, e);
      }
    }
    
    const after = getReplacementRecord(row.id);
    if (after && after.status === 'replacement_confirmed') {
      out.remediated++;
      audit(
        "stale_exit_auto_remediated",
        { orderId: row.original_order_id, symbol: row.symbol ?? "unknown", side: row.side ?? "unknown", status: "replaced", replacementOrderId: after.replacement_order_id },
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
