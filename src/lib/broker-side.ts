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
