// How a protective exit (synthetic-stop monitor OR proactive risk-exit) is routed with respect to the
// `allowExtendedHoursSyntheticStops` policy toggle ("App stops in extended hours").
//
// The honest default (toggle OFF, or a regular/closed session): a plain MARKET order tagged
// regular_hours — unchanged behavior. A stop that triggers pre/post-market rests at the broker until
// the 09:30 open (market-certainty at the open; you eat any overnight gap).
//
// When the toggle is ON *and* it is the pre/post session: a MARKETABLE-LIMIT order tagged
// extended_hours. This is the ONLY way the exit can actually fill after hours — Alpaca rejects a
// market order with extended_hours=true (extended-hours orders must be DAY limit orders), and the MCP
// path drops the flag entirely, so the previous "market + extended_hours" attempt either 422'd or
// no-op'd. The limit crosses the spread off the current quote so it fills in thin liquidity: a SELL
// prices DOWN off the BID and a COVER/buy-to-close UP off the ASK (the side the order must cross to
// be marketable — the composite quote price is ask-biased), by `marketableLimitBufferBps` (default
// 15). Residual risk the owner accepted: a violent gap can blow through the limit and not fill.
//
// Fails safe everywhere: no usable price, "limit" not in permittedOrderTypes, a fractional exit
// quantity (fractional orders are regular-hours-only at the broker and hard-blocked by policy), or
// the toggle off ⇒ fall back to the market/queue-to-open routing rather than leave a position
// unprotected.

import { currentMarketSession } from "./market-hours";
import type { TradeProposal, TradingPolicy } from "./types";

const DEFAULT_MARKETABLE_LIMIT_BUFFER_BPS = 15;
// Sanity ceiling for the tunable buffer: 500 bps = 5% through the quote. Anything past that is a
// typo/units mistake (e.g. percent typed into a bps field), not a plausible crossing buffer.
const MAX_MARKETABLE_LIMIT_BUFFER_BPS = 500;

export interface ProtectiveExitRouting {
  type: "market" | "limit";
  marketHours: "regular_hours" | "extended_hours";
  /** Set only when `type === "limit"`. */
  limitPrice?: number;
}

/**
 * Quote reference for pricing a protective exit. `bid`/`ask` (when real and positive) anchor the
 * side the order must cross; `price` is the composite/last price used as the fallback anchor when
 * that side is missing. Callers must not pass a synthesized (price-derived) spread side — leave it
 * undefined so the composite fallback applies (mirrors the entry marketable-limit guard).
 */
export interface ProtectiveExitQuote {
  price?: number;
  bid?: number;
  ask?: number;
}

const MARKET_REGULAR: ProtectiveExitRouting = { type: "market", marketHours: "regular_hours" };

/**
 * The marketable-limit buffer (bps) to use for an extended-hours protective exit RIGHT NOW, or
 * undefined when extended-hours routing does not apply (toggle off, "limit" not permitted, or the
 * current session is regular/closed). Shared by the synthetic monitor and the async strategy run so
 * the session/permission decision is made in exactly one place. `now` is injectable for tests.
 */
export function extendedHoursExitBufferBps(policy: TradingPolicy, now?: Date): number | undefined {
  if (policy.allowExtendedHoursSyntheticStops !== true) return undefined;
  // A limit order is mandatory in the extended session; honor the permitted-order-types cage.
  if (!(policy.permittedOrderTypes?.includes("limit") ?? true)) return undefined;
  const session = currentMarketSession(now);
  if (session !== "pre" && session !== "post") return undefined;
  // Validate the tunable: the policy route bounds NEW saves, but an already-stored zero/negative
  // buffer would INVERT the marketable price (a SELL limit at/above the reference rests unfilled)
  // — fall back to the default rather than price an exit off a nonsense buffer.
  const tuned = policy.tuning?.marketableLimitBufferBps;
  if (typeof tuned !== "number" || !Number.isFinite(tuned) || tuned <= 0) return DEFAULT_MARKETABLE_LIMIT_BUFFER_BPS;
  return Math.min(tuned, MAX_MARKETABLE_LIMIT_BUFFER_BPS);
}

/**
 * Marketable-limit price for a protective exit: cross the spread so a thin-liquidity extended-hours
 * order still fills. A SELL (long exit) prices DOWN off the BID and a COVER (short buy-to-close)
 * prices UP off the ASK — pricing a SELL off the composite quote price (ask ?? bid on Alpaca) would
 * leave the limit ABOVE the bid on any spread wider than the buffer, i.e. not marketable at all.
 * The composite `price` is only the fallback anchor when the crossing side is missing. Returns
 * undefined when no usable anchor exists so the caller falls back to a market order. Mirrors the
 * entry marketable-limit rounding (2 dp).
 */
export function marketableLimitExitPrice(quote: ProtectiveExitQuote, exitSide: "sell" | "cover", bufferBps: number): number | undefined {
  const usable = (value: number | undefined): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  const anchor = exitSide === "cover" ? (usable(quote.ask) ?? usable(quote.price)) : (usable(quote.bid) ?? usable(quote.price));
  if (anchor === undefined) return undefined;
  const buffer = bufferBps / 10_000;
  const raw = exitSide === "cover" ? anchor * (1 + buffer) : anchor * (1 - buffer);
  const price = Math.round(raw * 100) / 100;
  return price > 0 ? price : undefined;
}

/**
 * Resolve routing for a single protective exit given the live policy, the exit side, the last known
 * quote, and the exit quantity. Used by the every-tick synthetic monitor (which has `now` = wall
 * clock) and by the approval-time reprice below. Returns the market/queue-to-open default unless the
 * extended-hours toggle applies in the current session, the quantity is a whole share count
 * (fractional orders are regular-hours-only at the broker and hard-blocked by policy — routing one
 * to extended hours would block the exit instead of queuing it), and a usable marketable-limit price
 * can be computed.
 */
export function resolveProtectiveExitRouting(
  policy: TradingPolicy,
  exitSide: "sell" | "cover",
  quote: ProtectiveExitQuote | undefined,
  now?: Date,
  quantity?: number
): ProtectiveExitRouting {
  const bufferBps = extendedHoursExitBufferBps(policy, now);
  if (bufferBps === undefined || quote === undefined) return MARKET_REGULAR;
  if (quantity !== undefined && !Number.isInteger(quantity)) return MARKET_REGULAR;
  const limitPrice = marketableLimitExitPrice(quote, exitSide, bufferBps);
  if (limitPrice === undefined) return MARKET_REGULAR;
  return { type: "limit", marketHours: "extended_hours", limitPrice };
}

/**
 * Re-resolve a STORED protective exit's routing at placement time. Under propose authority the
 * Risk-Exit card can sit for minutes/hours between generation and the human Approve; an
 * extended-hours marketable-limit is only as good as the quote it was priced off, so a market that
 * moved through the stale limit would leave the once-marketable order resting unfilled exactly where
 * the queue-to-open market exit would still get out. Recomputes routing against the fresh quote and
 * wall clock, degrading to market/regular_hours when extended-hours routing no longer applies
 * (session over, toggle off, no usable quote). Anything that is not an extended-hours
 * protective-exit limit passes through untouched — entries and regular-hours exits keep their
 * reviewed shape.
 */
export function repriceStoredProtectiveExit(
  proposal: TradeProposal,
  policy: TradingPolicy,
  quote: ProtectiveExitQuote | undefined,
  now?: Date
): TradeProposal {
  const isProtectiveExit = proposal.tradeThesisTag === "Risk-Exit" || proposal.tradeThesisTag === "Synthetic Stop";
  if (!isProtectiveExit || proposal.type !== "limit" || proposal.marketHours !== "extended_hours") return proposal;
  if (proposal.side !== "sell" && proposal.side !== "cover") return proposal;
  const routing = resolveProtectiveExitRouting(policy, proposal.side, quote, now, proposal.quantity);
  if (routing.type === "limit" && routing.limitPrice === proposal.limitPrice) return proposal;
  return { ...proposal, type: routing.type, limitPrice: routing.limitPrice, marketHours: routing.marketHours };
}
