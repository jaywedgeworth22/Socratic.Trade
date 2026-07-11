import type { OrderSide } from "./types";

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
//
// Deliberate omissions (do NOT add these here):
//   - `done_for_day` / `stopped` / `calculated` are WORKING/active states elsewhere in the codebase
//     (order-replacement.ts POST_CANCEL_ACTIVE_STATES, stale-limit-orders.ts EXTRA_WORKING_STATES,
//     dashboard-feed.ts), NOT declines. In the placement reconcile (strategy.ts) an order in one of
//     these falls through to the recovery/"placed" branch, which already books its executed
//     `filledQuantity` — so a done_for_day/stopped order that PARTIALLY filled is still ledgered
//     without treating it as a decline. `stopped` in particular is Alpaca's "a trade is guaranteed
//     but has not yet occurred", so declaring it terminal would risk dropping an imminent fill.
//   - `replaced` is NOT a decline: the order was superseded by a live REPLACEMENT order
//     (order-replacement.ts), which is what actually rests at the broker. Adding it here would
//     mislabel a live/superseded order as declined.
// The money-path invariant "book any executed partial on a matched terminal order" is enforced by
// the reconcile paths (they book `filledQuantity` on ANY matched order that carries executed shares),
// not by widening this decline set.
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
