// True broker-held protective stops for Robinhood.
//
// Robinhood's MCP cannot hold a native OCO bracket (unlike Alpaca), so a held position is otherwise
// protected only by the app's synthetic scheduler-tick monitor — a single point of failure if the
// app is offline. This module places a resting broker-side stop-market SELL (GTC) at stopLossPct
// below entry for each open Robinhood LIVE long, and cancels it when the position closes or a
// synthetic exit fires (so an orphaned stop can't sell shares we no longer hold).
//
// Reconciliation runs from the synthetic-stop monitor each tick: it CANCELS stops for closed
// positions every time (risk-reducing, always safe) and PLACES missing stops only when the system is
// running. This self-heals — a restart re-places any missing stops for still-open positions. The
// opt-in policy.robinhoodBrokerStops flag (default off) gates only PLACEMENT: when the flag is
// turned off (or the run is no longer live Robinhood), reconcile still CANCELS every stop the
// feature previously placed for the account, so disabling the feature tears its resting stops down
// instead of orphaning them. The always-on synthetic monitor remains the fallback, so this is purely
// additive protection.
//
// A pending_cancel row whose cancel call keeps failing (e.g. "order not found" after an earlier
// attempt actually landed broker-side) would otherwise retry forever and permanently block
// re-placement for that symbol. The caller's freshly fetched order list (`orders`, optional) lets
// section 1 recover: if the order shows up there already done resting (filled/rejected/canceled/
// expired), the row is deleted instead of retried again. Absent-from-list or still-live stays
// ambiguous and keeps retrying — never assume terminal without positive evidence.

import {
  audit,
  deleteBrokerProtectiveStop,
  listBrokerProtectiveStops,
  upsertBrokerProtectiveStop
} from "./db";
import { isRejectedOrCanceledState } from "./broker-side";
import { normalizeSymbol } from "./money";
import { livePreflightBlocks } from "./preflight-live-guard";
import type { BrokerGateway, EquityOrder, EquityPosition, ExecutionMode, TradingPolicy } from "./types";

/**
 * True when a broker order is done resting for reasons other than an app-issued cancel actually
 * landing — either the broker declined/terminated it (rejected/canceled/expired/failed, both
 * spellings) or it already FILLED. Both are terminal from a "should we keep retrying the cancel"
 * standpoint: a filled stop can never be cancelled (the broker will just keep erroring), and a
 * declined/expired one never rested to begin with. Deliberately narrower than "not live" — an
 * UNRECOGNIZED state must NOT count as terminal here, or a still-resting order in an unfamiliar
 * state would get its local row deleted while the broker-side stop keeps resting, letting a later
 * tick place a second stop over it (two resting sell stops, one invisible — the same failure mode
 * the section-4 placement guard exists to avoid).
 */
function isDoneRestingState(state: string | undefined | null): boolean {
  return isRejectedOrCanceledState(state) || String(state ?? "").trim().toLowerCase() === "filled";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when broker-held protective stops should be maintained for this run. */
export function brokerProtectiveStopsEnabled(policy: TradingPolicy, executionMode: ExecutionMode): boolean {
  return (
    policy.robinhoodBrokerStops === true &&
    executionMode === "broker/live" &&
    policy.activeBroker === "robinhood" &&
    (policy.riskRules?.stopLossPct ?? 0) > 0
  );
}

/**
 * Cancel + forget the resting protective stop(s) for one symbol (best-effort). Safe to call
 * unconditionally — used when a synthetic exit fires so the resting stop can't double-sell.
 */
export async function cancelBrokerProtectiveStop(
  userId: string,
  accountNumber: string,
  symbol: string,
  gateway: BrokerGateway
): Promise<void> {
  const sym = normalizeSymbol(symbol);
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (normalizeSymbol(row.symbol) !== sym) continue;
    try {
      await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
      deleteBrokerProtectiveStop(row.id, userId);
    } catch (err) {
      audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: row.brokerOrderId, error: errMsg(err) }, userId);
      // Mark as pending_cancel in DB instead of deleting immediately, to retry later
      upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
    }
  }
}

export interface ReconcileResult {
  placed: number;
  cancelled: number;
  /**
   * Broker order ids this reconcile successfully cancelled (one per `cancelled` count). The caller
   * fetched its order list BEFORE reconcile ran, so these orders still look live in that list —
   * it must drop them before deciding whether a symbol is already protected, or a just-torn-down
   * stop suppresses synthetic registration and leaves the position with neither protection.
   */
  cancelledOrderIds: string[];
  /**
   * Normalized symbols this reconcile successfully PLACED a resting broker stop for (one per
   * `placed` count) — the mirror image of `cancelledOrderIds` for the same pre-reconcile-fetch
   * staleness: the caller's order list CANNOT contain these just-placed orders, so quantity-aware
   * coverage would undercount them. On a mismatch cancel/REPLACE tick that undercount is what let
   * the synthetic monitor register + fire against the pruned pre-replace coverage and then cancel
   * the fresh full-size replacement. The caller must treat these symbols as broker-covered for
   * THIS tick — both synthetic REGISTRATION and the FIRE path of already-registered rows (a fire
   * would sell shares the just-placed full-size stop covers, then cancel that stop after booking
   * the fill); the next tick's fresh order fetch sees the real resting order.
   */
  placedStopSymbols: string[];
}

/**
 * Reconcile broker-held protective stops against current positions. Cancels stops whose position has
 * closed (always), then — only when `running` — places a resting stop for each open long that lacks
 * one. No-op unless the policy flag is on and execution is live Robinhood.
 */
export async function reconcileBrokerProtectiveStops(args: {
  userId: string;
  policy: TradingPolicy;
  accountNumber: string;
  gateway: BrokerGateway;
  positions: EquityPosition[];
  executionMode: ExecutionMode;
  running: boolean;
  /**
   * The caller's freshly fetched broker order list (e.g. the synthetic-stop monitor's
   * `gateway.getEquityOrders` call earlier in the same tick). Used ONLY by the section-1
   * pending_cancel retry, to recover a row whose cancel call keeps failing even though the
   * order is already done resting broker-side (e.g. "order not found" after an earlier cancel
   * attempt actually landed, or the stop simply filled). Optional and defaults to empty — a
   * caller that omits it (or a failed fetch) just keeps the existing conservative behavior
   * (absent-from-list stays ambiguous, so the row keeps retrying rather than getting deleted).
   */
  orders?: EquityOrder[];
}): Promise<ReconcileResult> {
  const { userId, policy, accountNumber, gateway, positions, executionMode, running, orders = [] } = args;
  const out: ReconcileResult = { placed: 0, cancelled: 0, cancelledOrderIds: [], placedStopSymbols: [] };

  // The flag gates only PLACEMENT of new stops — never CANCELLATION. When the feature is disabled
  // (flag off) or no longer applicable (not live Robinhood, no stop-loss %), any stop it previously
  // placed is still resting live at the broker. Turning the feature off must TEAR THOSE DOWN, not
  // strand them: an orphaned GTC stop-market SELL would rest forever with no app-side cleanup and
  // could later sell shares the user no longer intends to protect this way. This teardown is pure
  // risk reduction (it never places a replacement), so the `liveReplaceBlocked` "never leave a
  // position unprotected" guard — which only matters when we cancel WITH intent to re-place — does
  // not apply here. If no rows exist, this is a true no-op (the common disabled/default case).
  if (!brokerProtectiveStopsEnabled(policy, executionMode)) {
    for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
      } catch (err) {
        audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err), context: "disabled_teardown" }, userId);
        // Keep it as pending_cancel so a later tick retries the cancel rather than orphaning the
        // resting broker stop (listBrokerProtectiveStops returns pending_cancel rows, so the next
        // disabled reconcile re-attempts it).
        upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
      }
    }
    return out;
  }

  const stopPct = policy.riskRules!.stopLossPct!;

  // Robinhood is long-only, so protective stops only apply to long positions. Computed UP FRONT
  // (before any cancel) so the guards below know which positions are still open.
  const liveLongs = new Map<string, EquityPosition>();
  for (const p of positions) {
    if (p.quantity > 0.000001) liveLongs.set(normalizeSymbol(p.symbol), p);
  }
  // Would a live REPLACEMENT stop be blocked (broker/live without ALLOW_LIVE_TRADING)? If so, we must
  // not cancel an OPEN position's only stop with no replacement — that would leave it unprotected.
  // Cancels for CLOSED positions stay risk-reducing and are never blocked.
  const liveReplaceBlocked = livePreflightBlocks({ mode: executionMode });

  // 1. Retry pending cancellations first — but for a STILL-OPEN position, skip the retry when a
  //    replacement can't be placed (keep its existing stop rather than orphaning the position).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") {
      if (liveReplaceBlocked && liveLongs.has(normalizeSymbol(row.symbol))) continue;
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
      } catch (err) {
        // The cancel call itself failed — but that doesn't necessarily mean the order is still
        // resting broker-side (e.g. a prior cancel attempt actually landed and this one is just
        // "order not found", or the stop simply filled before the cancel reached the broker).
        // Check the caller's freshly fetched order list: if the order shows up there in a state
        // that's done resting (filled/rejected/canceled/expired), the row is stale bookkeeping —
        // delete it so section 4 can re-place for the symbol on a later tick. If the order is
        // ABSENT from the list or still live, stay conservative and keep retrying next tick
        // (an absent order is ambiguous, not confirmed dead — see broker-protective-stops.ts's
        // module doc and the section-4 "never orphan a possibly-still-live stop" guard).
        const found = orders.find((o) => o.id === row.brokerOrderId);
        if (found && isDoneRestingState(found.state)) {
          deleteBrokerProtectiveStop(row.id, userId);
          audit(
            "broker_protective_stop_cancel_recovered",
            { symbol: row.symbol, brokerOrderId: row.brokerOrderId, brokerState: found.state, error: errMsg(err) },
            userId
          );
        } else {
          // Keep it in DB as pending_cancel to retry on the next tick
          console.error(`[protective-stops] retry cancel failed for ${row.symbol} order ${row.brokerOrderId}:`, err);
        }
      }
    }
  }

  // 2. Cancel-on-close (runs regardless of `running` — cancelling is always risk-reducing).
  for (const row of listBrokerProtectiveStops(accountNumber, userId)) {
    if (row.status === "pending_cancel") continue; // already handled
    if (!liveLongs.has(normalizeSymbol(row.symbol))) {
      try {
        await gateway.cancelEquityOrder(accountNumber, row.brokerOrderId);
        deleteBrokerProtectiveStop(row.id, userId);
        out.cancelled++;
        out.cancelledOrderIds.push(row.brokerOrderId);
      } catch (err) {
        audit("broker_protective_stop_cancel_error", { symbol: row.symbol, brokerOrderId: row.brokerOrderId, error: errMsg(err) }, userId);
        // Mark as pending_cancel to retry later
        upsertBrokerProtectiveStop({ ...row, status: "pending_cancel" });
      }
    }
  }

  if (!running) return out;

  // 3. Mismatch detection: if quantity or stop price has drifted, cancel the existing stop.
  // On the next loop, it will be re-placed with correct values. This is a cancel-THEN-place: if the
  // re-place (section 4) would be blocked (`liveReplaceBlocked`, computed above), skip the cancel so we
  // KEEP the existing (slightly-mismatched) protective stop rather than orphaning the position.
  const existingStops = listBrokerProtectiveStops(accountNumber, userId);
  for (const [sym, pos] of liveLongs) {
    const existingStop = existingStops.find((r) => normalizeSymbol(r.symbol) === sym);
    if (existingStop && existingStop.status === "resting") {
      const qty = Math.abs(pos.quantity);
      const targetStopPrice = round2(pos.averageCost * (1 - stopPct / 100));

      const qtyMismatch = Math.abs(existingStop.quantity - qty) > 0.000001;
      const priceMismatch = Math.abs(existingStop.stopPrice - targetStopPrice) > 0.02;

      if ((qtyMismatch || priceMismatch) && !liveReplaceBlocked) {
        audit("broker_protective_stop_mismatch", {
          symbol: sym,
          oldQty: existingStop.quantity,
          newQty: qty,
          oldStopPrice: existingStop.stopPrice,
          newStopPrice: targetStopPrice
        }, userId);

        try {
          await gateway.cancelEquityOrder(accountNumber, existingStop.brokerOrderId);
          deleteBrokerProtectiveStop(existingStop.id, userId);
          out.cancelled++;
          out.cancelledOrderIds.push(existingStop.brokerOrderId);
        } catch (err) {
          audit("broker_protective_stop_cancel_error", { symbol: sym, brokerOrderId: existingStop.brokerOrderId, error: errMsg(err) }, userId);
          upsertBrokerProtectiveStop({ ...existingStop, status: "pending_cancel" });
        }
      }
    }
  }

  // 4. Place-if-missing for each open long without a stop row. A pending_cancel row BLOCKS
  // placement for its symbol: its broker order may still be live (the cancel keeps failing), and
  // placing a replacement would upsert a new broker_order_id over the row (UNIQUE
  // user/account/symbol), orphaning the old still-live full-size GTC stop with no tracking and no
  // retry — two resting sell stops, one invisible. The section-1 retry keeps re-attempting the
  // cancel; placement resumes on the tick after it succeeds (and until then the old stop itself is
  // still protecting the position).
  const currentStops = listBrokerProtectiveStops(accountNumber, userId);
  const existing = new Set(currentStops.map((r) => normalizeSymbol(r.symbol)));

  for (const [sym, pos] of liveLongs) {
    if (existing.has(sym)) continue;
    if (!(pos.averageCost > 0)) continue;
    const qty = Math.abs(pos.quantity);
    const stopPrice = round2(pos.averageCost * (1 - stopPct / 100));
    if (!(stopPrice > 0)) continue;
    const refId = `protstop-${userId}-${accountNumber}-${sym}-${Date.now()}`;
    try {
      const exec = await gateway.placeEquityOrder({
        accountNumber,
        symbol: sym,
        side: "sell",
        type: "stop_market",
        quantity: qty,
        stopPrice,
        timeInForce: "gtc",
        marketHours: "regular_hours",
        refId
      });
      if (isRejectedOrCanceledState(exec.state)) {
        // A non-throwing placement can still be a synchronous rejection/cancellation (same trap as
        // the synthetic exit path in synthetic-stops.ts). No stop is resting at the broker: don't
        // record a row (a dead "resting" row would block re-placement here on every later tick —
        // section 3 sees no qty/price mismatch on it, and `existing` above blocks section 4) and
        // don't advertise the symbol via placedStopSymbols (that would suppress this tick's
        // synthetic registration for protection that doesn't exist).
        audit("broker_protective_stop_error", { symbol: sym, stopPrice, orderId: exec.orderId, error: `broker declined the protective stop (state: ${exec.state})` }, userId);
        continue;
      }
      if (!exec.orderId) {
        // No broker order id means we couldn't later cancel it — don't record an untrackable stop.
        audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: "broker returned no order id" }, userId);
        continue;
      }
      upsertBrokerProtectiveStop({
        id: `protstop-${userId}-${accountNumber}-${sym}`,
        userId,
        accountNumber,
        symbol: sym,
        brokerOrderId: exec.orderId,
        quantity: qty,
        stopPrice,
        status: "resting"
      });
      out.placed++;
      out.placedStopSymbols.push(sym);
      audit("broker_protective_stop_placed", { symbol: sym, stopPrice, quantity: qty, brokerOrderId: exec.orderId }, userId);
    } catch (err) {
      audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: errMsg(err) }, userId);
    }
  }
  return out;
}
