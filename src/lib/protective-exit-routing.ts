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
// no-op'd. The limit crosses the spread off the last quote so it fills in thin liquidity (a SELL
// prices DOWN, a COVER/buy-to-close prices UP, by `marketableLimitBufferBps`, default 15). Residual
// risk the owner accepted: a violent gap can blow through the limit and not fill.
//
// Fails safe everywhere: no usable price, "limit" not in permittedOrderTypes, or the toggle off ⇒
// fall back to the market/queue-to-open routing rather than leave a position unprotected.

import { currentMarketSession } from "./market-hours";
import type { TradingPolicy } from "./types";

const DEFAULT_MARKETABLE_LIMIT_BUFFER_BPS = 15;

export interface ProtectiveExitRouting {
  type: "market" | "limit";
  marketHours: "regular_hours" | "extended_hours";
  /** Set only when `type === "limit"`. */
  limitPrice?: number;
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
  return policy.tuning?.marketableLimitBufferBps ?? DEFAULT_MARKETABLE_LIMIT_BUFFER_BPS;
}

/**
 * Marketable-limit price for a protective exit: cross the spread off `refPrice` so a thin-liquidity
 * extended-hours order still fills. A SELL (long exit) prices DOWN; a COVER (short buy-to-close)
 * prices UP. Returns undefined for a non-positive price so the caller falls back to a market order.
 * Mirrors the entry marketable-limit rounding (2 dp).
 */
export function marketableLimitExitPrice(refPrice: number, exitSide: "sell" | "cover", bufferBps: number): number | undefined {
  if (!(refPrice > 0)) return undefined;
  const buffer = bufferBps / 10_000;
  const raw = exitSide === "cover" ? refPrice * (1 + buffer) : refPrice * (1 - buffer);
  const price = Math.round(raw * 100) / 100;
  return price > 0 ? price : undefined;
}

/**
 * Resolve routing for a single protective exit given the live policy, the exit side, and the last
 * known price. Used by the every-tick synthetic monitor (which has `now` = wall clock). Returns the
 * market/queue-to-open default unless the extended-hours toggle applies in the current session and a
 * usable marketable-limit price can be computed.
 */
export function resolveProtectiveExitRouting(
  policy: TradingPolicy,
  exitSide: "sell" | "cover",
  refPrice: number | undefined,
  now?: Date
): ProtectiveExitRouting {
  const bufferBps = extendedHoursExitBufferBps(policy, now);
  if (bufferBps === undefined || refPrice === undefined) return MARKET_REGULAR;
  const limitPrice = marketableLimitExitPrice(refPrice, exitSide, bufferBps);
  if (limitPrice === undefined) return MARKET_REGULAR;
  return { type: "limit", marketHours: "extended_hours", limitPrice };
}
