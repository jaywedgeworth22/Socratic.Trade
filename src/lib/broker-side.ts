import { normalizeSymbol } from "./money";
import type { EquityOrder, OrderSide } from "./types";

// Our internal OrderSide encodes intent relative to the position: "buy"/"sell" act on a long,
// "short"/"cover" act on a short. Real equity broker order APIs (Alpaca, Robinhood) only accept
// "buy" or "sell" — the broker infers open-vs-close from the account's current position. So a
// "short" is submitted to the broker as a "sell" (sell shares you don't own → opens a short), and a
// "cover" is submitted as a "buy" (buy to close the short). Forwarding the raw 4-value side to the
// broker produces an invalid request; every broker submission must translate through this function.

/** Translate our 4-value intent side to the broker's 2-value equity order side. */
export function toBrokerSide(side: OrderSide): "buy" | "sell" {
  return side === "buy" || side === "cover" ? "buy" : "sell";
}

/** The short-side intents that a broker without equity shorting (e.g. Robinhood) must reject. */
export function isShortIntent(side: OrderSide): boolean {
  return side === "short" || side === "cover";
}

// Broker order-state vocabularies aren't normalized to one canonical enum (Alpaca and Robinhood
// each return their own raw state strings, with spelling variants like "canceled"/"cancelled").
// This is the single broker-agnostic check for "the broker declined/terminated this order without
// a fill" — used both immediately after placement (so a synchronous broker rejection isn't
// mislabeled "placed") and by the later reconciliation sweep (so both spellings/brokers match).
const TERMINAL_DECLINE_STATES = new Set(["rejected", "canceled", "cancelled", "failed", "expired"]);

export function isRejectedOrCanceledState(state: string | undefined | null): boolean {
  return TERMINAL_DECLINE_STATES.has(String(state ?? "").trim().toLowerCase());
}

// The complementary broker-agnostic check: "this order is still RESTING/LIVE at the broker"
// (placed, not yet filled/canceled/expired/rejected/failed). Like the decline check above, the raw
// vocabularies aren't normalized to one enum — Alpaca emits new/accepted/pending_new/…/partially_
// filled, while Robinhood's resting states are queued/confirmed/unconfirmed. Both vocabularies are
// listed here so a caller (e.g. the synthetic-stop monitor deciding whether a symbol is already
// protected by a broker-held stop) recognizes a live order regardless of broker. The two
// vocabularies are disjoint — Alpaca never emits queued/confirmed/unconfirmed and Robinhood never
// emits Alpaca's — so recognizing Robinhood's resting states here can never reclassify an Alpaca
// order. Bias: list only clearly-live states, so a terminal or unknown status is treated as NOT
// live (when unsure, don't suppress protection).
const LIVE_ORDER_STATES = new Set([
  // Alpaca-flavored resting/working states.
  "new", "accepted", "pending_new", "accepted_for_bidding", "held", "calculated", "partially_filled", "open",
  // Robinhood-flavored resting states (get_equity_orders reports a working stop as one of these).
  "queued", "confirmed", "unconfirmed",
  // Non-terminal in-transition states. "pending_cancel"/"pending_replace" are deliberate: an order
  // whose cancel/replace is merely REQUESTED can still fill, so it must keep counting as live
  // protection/coverage until the broker confirms it dead — treating it as gone is what lets a
  // duplicate exit stack on top of it. This set must stay a superset of broker-held-orders.ts's
  // ACTIVE_BROKER_ORDER_STATES (guarded by a test in broker-side.test.ts) so the two active-state
  // vocabularies can't silently drift apart again.
  "submitted", "pending_cancel", "pending_replace", "suspended"
]);

export function isLiveOrderState(state: string | undefined | null): boolean {
  return LIVE_ORDER_STATES.has(String(state ?? "").trim().toLowerCase());
}

/**
 * A live open order that EXITS the position — market, limit, or stop; any of them reduces the
 * position when it executes, so any of them counts as protection. Only recognizing /stop/i-type
 * orders is what let the 2026-07-08 MU monitor fire again on top of its own resting market sell.
 * A long exits with a sell; a short exits with a cover, which brokers that infer open/close from
 * the position (Alpaca) report as a raw "buy". A broker-held stop (an Alpaca OCO bracket leg, or a
 * Robinhood broker-held protective stop in queued/confirmed/unconfirmed) is just a live exit-side
 * order, so it counts here too — there is deliberately NO separate "symbol has a live stop"
 * shortcut, which was side- and quantity-blind: a stop-BUY add-on, or a stop covering 10 of 100
 * shares, suppressed synthetic protection for shares it never covered.
 */
export function isLiveExitOrder(order: EquityOrder, positionSide: "long" | "short"): boolean {
  if (!isLiveOrderState(order.state)) return false;
  const side = String(order.side).trim().toLowerCase();
  return positionSide === "long" ? side === "sell" : side === "cover" || side === "buy";
}

/**
 * Quantity-aware protection coverage from live exit orders. `coveredQty` sums the REMAINING open
 * quantity (quantity - filledQuantity, per the stale-limit-orders convention) across live exit
 * orders for the symbol/side. `unknownQty` is true when any live exit order's remaining quantity is
 * unknowable (e.g. a notional/dollarAmount order reports no share quantity) — callers must then
 * treat the position as fully covered, failing toward no-duplicate-sell: those shares are
 * broker-held, and a second sell of them would be rejected anyway. A FULL-size resting exit at any
 * price correctly blocks firing for the same reason — the stale-limit-order notifier is the surface
 * that flags a far-from-market full-size limit, not a duplicate market sell from here.
 */
export function liveExitOrderCoverage(
  orders: EquityOrder[],
  symbol: string,
  positionSide: "long" | "short"
): { coveredQty: number; unknownQty: boolean } {
  let coveredQty = 0;
  let unknownQty = false;
  for (const order of orders) {
    if (normalizeSymbol(order.symbol) !== symbol || !isLiveExitOrder(order, positionSide)) continue;
    if (typeof order.quantity !== "number" || !Number.isFinite(order.quantity) || order.quantity <= 0) {
      unknownQty = true;
      continue;
    }
    coveredQty += Math.max(order.quantity - (order.filledQuantity ?? 0), 0);
  }
  return { coveredQty, unknownQty };
}
