// True broker-held protective stops — two kinds, one reconciler:
//
//  - FIXED (Robinhood, opt-in `robinhoodBrokerStops`): Robinhood's MCP cannot hold a native OCO
//    bracket (unlike Alpaca), so a held position is otherwise protected only by the app's synthetic
//    scheduler-tick monitor — a single point of failure if the app is offline. This lane places a
//    resting broker-side stop-market SELL (GTC) at stopLossPct below entry for each open Robinhood
//    LIVE long, and cancels it when the position closes or a synthetic exit fires (so an orphaned
//    stop can't sell shares we no longer hold).
//
//  - TRAILING (`brokerTrailingStops`, default on; inert until riskRules.trailingStopPct > 0):
//     * Alpaca REST (paper or live): a TRUE native `trailing_stop` order (trail_percent) — the
//       broker trails the high-water mark itself, so the trail keeps moving even while the app is
//       down.
//     * Alpaca MCP: the ratcheted emulation below, through the account's own MCP transport — an
//       MCP-endpoint-only account has no REST keys for the native lane.
//     * Robinhood (live, additionally gated on `robinhoodBrokerStops` — the "resting stops at RH
//       are live-verified" opt-in): the RH MCP exposes no verified native trailing parameter, so
//       this lane places a resting GTC stop-market at trailingStopPct below the high-water mark and
//       RATCHETS it upward (cancel-replace) each tick as the price rises. Between ticks the broker
//       holds a real fixed stop — protection survives app downtime; the trail catches up on the
//       app's cadence.
//    Trailing takes precedence over fixed when both lanes apply: shares can only back ONE resting
//    sell order at the broker, so a position carries either the trailing or the fixed broker stop,
//    never both (the synthetic monitor still layers the other rule on its tick, as always).
//
// Reconciliation runs from the synthetic-stop monitor each tick: it CANCELS stops for closed
// positions every time (risk-reducing, always safe) and PLACES missing stops only when the system is
// running. This self-heals — a restart re-places any missing stops for still-open positions. The
// enabling flags gate only PLACEMENT: when no lane is enabled any more, reconcile still CANCELS
// every stop the feature previously placed for the account, so disabling tears its resting stops
// down instead of orphaning them. Placement is coverage-aware when the caller supplies its order
// list: a position whose shares are already backed by another live exit-side order (an Alpaca OCO
// bracket stop leg, a manual GTC sell) is skipped instead of provoking a broker rejection. The
// always-on synthetic monitor remains the fallback, so this is purely additive protection.

import {
  audit,
  deleteBrokerProtectiveStop,
  listBrokerProtectiveStops,
  upsertBrokerProtectiveStop
} from "./db";
import { isRejectedOrCanceledState, liveExitOrderCoverage } from "./broker-side";
import { normalizeSymbol } from "./money";
import { livePreflightBlocks } from "./preflight-live-guard";
import type { BrokerGateway, EquityOrder, EquityPosition, ExecutionMode, TradingPolicy } from "./types";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when FIXED broker-held protective stops (Robinhood lane) should be maintained. */
export function brokerProtectiveStopsEnabled(policy: TradingPolicy, executionMode: ExecutionMode): boolean {
  return (
    policy.robinhoodBrokerStops === true &&
    executionMode === "broker/live" &&
    policy.activeBroker === "robinhood" &&
    (policy.riskRules?.stopLossPct ?? 0) > 0
  );
}

/**
 * True when broker-held TRAILING stops should be maintained. Requires a configured trailing % and
 * the `brokerTrailingStops` preference (default on — `false` opts out). Alpaca supports native
 * trailing_stop orders in both environments; Robinhood only gets the ratcheted emulation on LIVE,
 * and only under the existing `robinhoodBrokerStops` opt-in (the flag that says "resting stops at
 * Robinhood have been live-verified").
 */
export function brokerTrailingStopsEnabled(policy: TradingPolicy, executionMode: ExecutionMode): boolean {
  if ((policy.riskRules?.trailingStopPct ?? 0) <= 0) return false;
  if (policy.brokerTrailingStops === false) return false;
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") return true;
  if (policy.activeBroker === "robinhood") {
    return executionMode === "broker/live" && policy.robinhoodBrokerStops === true;
  }
  return false;
}

/**
 * Which kind of broker-held protective stop this account should carry per open long. Trailing wins
 * when both lanes apply — a position's shares can only back one resting sell order at the broker.
 */
export function desiredBrokerStopKind(policy: TradingPolicy, executionMode: ExecutionMode): "fixed" | "trailing" | null {
  if (brokerTrailingStopsEnabled(policy, executionMode)) return "trailing";
  if (brokerProtectiveStopsEnabled(policy, executionMode)) return "fixed";
  return null;
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
   * the fill); the next tick's fresh order fetch sees the real resting order. ONLY full-position
   * placements are listed here — a PARTIAL placement goes in `partiallyPlacedStopSymbols` instead,
   * so suppressing registration can never leave the uncovered remainder stop-less for a tick.
   */
  placedStopSymbols: string[];
  /**
   * Symbols this reconcile placed a broker stop for covering only PART of the position (a
   * fractional remainder the native trailing lane floored away, or shares partially covered by
   * another live exit order). The caller must skip the synthetic FIRE path for these this tick
   * (the fresh order isn't in its stale coverage list — firing would double-sell the covered
   * shares) but must still REGISTER synthetic protection, so the uncovered remainder is never
   * left without a stop if the app dies before the next tick.
   */
  partiallyPlacedStopSymbols: string[];
}

/**
 * Reconcile broker-held protective stops against current positions. Cancels stops whose position has
 * closed (always), then — only when `running` — places a resting stop for each open long that lacks
 * one, of the kind `desiredBrokerStopKind` resolves for this account. No-op unless a lane is enabled.
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
   * Live open orders fetched by the caller BEFORE this reconcile (the synthetic monitor's list).
   * Placement uses it to skip a position whose shares are already backed by another live exit-side
   * order (an Alpaca OCO bracket stop leg, a manual GTC sell) — placing a second full-size sell for
   * the same shares is at best a broker rejection and at worst a double-sell. Optional: when absent,
   * placement behaves as before (protection over dedup). Orders cancelled by THIS reconcile are
   * pruned before the coverage check, so a just-replaced stop can't suppress its own replacement.
   */
  brokerOrders?: EquityOrder[];
}): Promise<ReconcileResult> {
  const { userId, policy, accountNumber, gateway, positions, executionMode, running, brokerOrders } = args;
  const out: ReconcileResult = { placed: 0, cancelled: 0, cancelledOrderIds: [], placedStopSymbols: [], partiallyPlacedStopSymbols: [] };

  const kind = desiredBrokerStopKind(policy, executionMode);

  // The flags gate only PLACEMENT of new stops — never CANCELLATION. When no lane is enabled any
  // more (flags off / not the applicable broker/environment / no configured %), any stop previously
  // placed is still resting live at the broker. Turning the feature off must TEAR THOSE DOWN, not
  // strand them: an orphaned GTC stop-market SELL would rest forever with no app-side cleanup and
  // could later sell shares the user no longer intends to protect this way. This teardown is pure
  // risk reduction (it never places a replacement), so the `liveReplaceBlocked` "never leave a
  // position unprotected" guard — which only matters when we cancel WITH intent to re-place — does
  // not apply here. If no rows exist, this is a true no-op (the common disabled/default case).
  if (kind === null) {
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

  const stopPct = policy.riskRules?.stopLossPct ?? 0;
  const trailPct = policy.riskRules?.trailingStopPct ?? 0;
  // Native trailing_stop orders exist only on the Alpaca REST lane. An `alpaca-mcp` account can be
  // configured with ONLY an MCP endpoint (no REST keys), and the gateway's trailing branch goes
  // REST-direct — so alpaca-mcp deliberately takes the ratcheted stop-market emulation through its
  // own MCP transport instead of failing placement every tick (Codex review, PR #1331).
  const nativeTrailing = policy.activeBroker === "alpaca";

  // Coverage-aware target quantity for a symbol's broker stop: the shares NOT already covered by
  // some OTHER live exit order (a bracket leg, a manual GTC sell, a resting take-profit trim).
  // Placing a stop for already-covered shares stacks more exit quantity than the account holds —
  // if both orders fill, the position is over-sold. Mirrors the synthetic fire path's
  // uncovered-remainder rule. `excludeOrderId` drops our OWN resting stop (the order a mismatch
  // replacement is about to cancel) from the count; orders this reconcile already cancelled are
  // dropped too. An unknowable order quantity counts as full coverage (failing toward
  // no-duplicate-sell). Without a caller-supplied order list, the full position quantity is used
  // (pre-coverage behavior — protection over dedup).
  const uncoveredQuantity = (pos: EquityPosition, sym: string, excludeOrderId?: string): number => {
    const full = Math.abs(pos.quantity);
    if (!brokerOrders) return full;
    const cancelled = new Set(out.cancelledOrderIds);
    const cov = liveExitOrderCoverage(
      brokerOrders.filter((o) => !cancelled.has(o.id) && o.id !== excludeOrderId),
      sym,
      "long"
    );
    if (cov.unknownQty) return 0;
    return Math.max(full - cov.coveredQty, 0);
  };

  // The share quantity a broker-held stop of this kind should cover: the uncovered remainder,
  // floored to whole shares on the native trailing lane (Alpaca rejects fractional trailing
  // stops) — the synthetic monitor's quantity-aware coverage picks up any remainder.
  const desiredStopQuantity = (pos: EquityPosition, sym: string, excludeOrderId?: string): number => {
    const qty = uncoveredQuantity(pos, sym, excludeOrderId);
    return kind === "trailing" && nativeTrailing ? Math.floor(qty) : qty;
  };

  // Trailing trigger for the ratcheted (non-native) lane: trailingStopPct below the high-water
  // mark, where the observable extreme is max(current mark, entry) — the same initial-extreme rule
  // the synthetic monitor uses when registering a trail. Only ever ratchets UP (see section 3).
  const trailingTriggerPrice = (pos: EquityPosition): number => {
    const mark = pos.marketValue / pos.quantity;
    return round2(Math.max(mark, pos.averageCost) * (1 - trailPct / 100));
  };

  // Long positions only: Robinhood is long-only, and the trailing lane deliberately starts with
  // longs too — Alpaca shorts keep the synthetic monitor's trailing coverage (a short's broker-held
  // trail is a follow-up; note it in the rollout doc before extending). Computed UP FRONT
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
        // Keep it in DB as pending_cancel to retry on the next tick
        console.error(`[protective-stops] retry cancel failed for ${row.symbol} order ${row.brokerOrderId}:`, err);
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

  // 3. Mismatch detection: if the stop's KIND no longer matches the account's desired kind, or its
  // quantity / price / trail has drifted, cancel the existing stop. On the same pass, section 4
  // re-places it with correct values. This is a cancel-THEN-place: if the re-place would be blocked
  // (`liveReplaceBlocked`, computed above), skip the cancel so we KEEP the existing
  // (slightly-mismatched) protective stop rather than orphaning the position.
  //
  // Kind-specific drift rules:
  //  - fixed: entry-anchored target stop price (as before).
  //  - trailing, native (Alpaca): the broker moves the trigger itself — only a changed trail % or
  //    quantity forces a replace; never reprice from here.
  //  - trailing, ratcheted (Robinhood): recompute the trigger from the current mark each tick and
  //    replace only when it moved UP meaningfully (≥ $0.02 and ≥ 0.1% of the resting trigger — a
  //    churn guard, so a flat tape doesn't cancel-replace every tick). A falling mark never lowers
  //    the trigger: that is the ratchet.
  const existingStops = listBrokerProtectiveStops(accountNumber, userId);
  for (const [sym, pos] of liveLongs) {
    const existingStop = existingStops.find((r) => normalizeSymbol(r.symbol) === sym);
    if (existingStop && existingStop.status === "resting") {
      const qty = desiredStopQuantity(pos, sym, existingStop.brokerOrderId);
      // Where section 4 would place this stop's trigger today (informational for native trailing —
      // the broker moves that trigger itself).
      const newStopPrice = kind === "fixed" ? round2(pos.averageCost * (1 - stopPct / 100)) : trailingTriggerPrice(pos);

      let mismatchNote: string | undefined;
      if (existingStop.kind !== kind) {
        mismatchNote = `stop kind ${existingStop.kind} -> ${kind}`;
      } else if (Math.abs(existingStop.quantity - qty) > 0.000001) {
        mismatchNote = "quantity drift";
      } else if (kind === "fixed") {
        if (Math.abs(existingStop.stopPrice - newStopPrice) > 0.02) mismatchNote = "stop price drift";
      } else if (Math.abs((existingStop.trailPercent ?? 0) - trailPct) > 0.0001) {
        mismatchNote = `trail % ${existingStop.trailPercent ?? 0} -> ${trailPct}`;
      } else if (!nativeTrailing && newStopPrice - existingStop.stopPrice >= Math.max(0.02, existingStop.stopPrice * 0.001)) {
        mismatchNote = `trail ratchet ${existingStop.stopPrice} -> ${newStopPrice}`;
      }

      if (mismatchNote && !liveReplaceBlocked) {
        audit("broker_protective_stop_mismatch", {
          symbol: sym,
          note: mismatchNote,
          kind,
          oldQty: existingStop.quantity,
          newQty: qty,
          oldStopPrice: existingStop.stopPrice,
          newStopPrice
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
    // The uncovered remainder (coverage-aware — never stack exit quantity on top of a live bracket
    // leg / manual sell; the just-cancelled replacement's own order is pruned inside), floored to
    // whole shares on the native trailing lane. Zero means either full coverage by other live exit
    // orders or a sub-share remainder — either way the synthetic monitor keeps covering it.
    const qty = desiredStopQuantity(pos, sym);
    if (!(qty > 0)) {
      audit("broker_protective_stop_skipped", {
        symbol: sym,
        kind,
        note: "no uncovered whole shares — other live exit orders (or sub-share size) cover this position; the synthetic monitor covers any remainder"
      }, userId);
      continue;
    }
    const stopPrice = kind === "fixed" ? round2(pos.averageCost * (1 - stopPct / 100)) : trailingTriggerPrice(pos);
    if (!(stopPrice > 0)) continue;
    // A trail that is ALREADY breached at placement time (mark at/below the entry-seeded trigger)
    // must not be armed at the broker: a native trailing order would restart the trail from the
    // CURRENT depressed market (deferring the exit by another full trail distance), and a ratcheted
    // stop would rest with its trigger above the market. Skip — and deliberately do NOT advertise
    // the symbol — so the synthetic monitor registers this tick and fires the app-defined exit
    // immediately. (Codex review, PR #1331.)
    if (kind === "trailing") {
      const mark = pos.marketValue / pos.quantity;
      if (stopPrice >= mark) {
        audit("broker_protective_stop_skipped", {
          symbol: sym,
          kind,
          stopPrice,
          mark,
          note: "trail already breached at placement — leaving the exit to the synthetic monitor instead of arming a fresh, lower broker trail"
        }, userId);
        continue;
      }
    }
    const refId = `protstop-${userId}-${accountNumber}-${sym}-${Date.now()}`;
    try {
      const exec = await gateway.placeEquityOrder({
        accountNumber,
        symbol: sym,
        side: "sell",
        type: "stop_market",
        quantity: qty,
        // Native trailing (Alpaca): the gateway translates trailPercent to a trailing_stop order
        // and the broker computes/moves the trigger itself — sending a stopPrice would be rejected.
        // Ratcheted trailing (Robinhood) and fixed stops rest at an explicit trigger.
        stopPrice: kind === "trailing" && nativeTrailing ? undefined : stopPrice,
        trailPercent: kind === "trailing" && nativeTrailing ? trailPct : undefined,
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
        // For native trailing this records the trigger the trail STARTED from (the broker moves the
        // real one); for fixed/ratcheted stops it is the actual resting trigger.
        stopPrice,
        status: "resting",
        kind,
        trailPercent: kind === "trailing" ? trailPct : undefined
      });
      out.placed++;
      if (qty >= Math.abs(pos.quantity) - 0.000001) out.placedStopSymbols.push(sym);
      else out.partiallyPlacedStopSymbols.push(sym);
      audit("broker_protective_stop_placed", { symbol: sym, kind, stopPrice, trailPercent: kind === "trailing" ? trailPct : undefined, quantity: qty, positionQuantity: Math.abs(pos.quantity), brokerOrderId: exec.orderId }, userId);
    } catch (err) {
      audit("broker_protective_stop_error", { symbol: sym, stopPrice, error: errMsg(err) }, userId);
    }
  }
  return out;
}
