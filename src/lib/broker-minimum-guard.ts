// broker-minimum-guard.ts — pre-flight guard for orders that are GUARANTEED to be rejected for
// landing below the active broker's minimum dollar-based/fractional order size.
//
// Root cause this exists for (2026-07-08): the live Robinhood "Agentic" account (~$4-5 NAV) tried
// an AAPL concentration trim every hour, forever. Sizing (maxOrderPctOfNav) clamped each trim to
// ~$0.20-0.23 — always under Robinhood's $1 minimum — so `placeEquityOrder` rejected it every time,
// producing a `run_failed` alert 11x/day with no end in sight. Robinhood's own `review_equity_order`
// pre-flight already announced this in advance (`order_checks.alertType` ==
// EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR / EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER — parsed into
// `ReviewedOrder.preflightBlock` by robinhood.ts) but nothing read it before this module.
//
// This is a CORRECTNESS fix, not a paternalistic cap: it only ever intercepts an order the broker
// has already told us (or that basic sizing math tells us) cannot possibly succeed at its current
// notional. It never blocks a valid order, and it carries no opinion on whether the underlying
// trim/rebalance idea is good — the owner can still raise the trim size, trim manually, or ignore it.
import { getInternalSetting, setInternalSetting } from "./db";
import { ROBINHOOD_MIN_ORDER_NOTIONAL } from "./robinhood";
import type { OrderSide, ReviewedOrder, TradingPolicy } from "./types";

/**
 * Known per-broker minimum dollar-based/fractional equity order size. Brokers with no known floor
 * are simply absent — the guard is a no-op for them rather than guessing a number. Sourced from
 * each broker's own named constant (never a re-hardcoded magic number here).
 */
const BROKER_MIN_ORDER_NOTIONAL: Partial<Record<NonNullable<TradingPolicy["activeBroker"]>, number>> = {
  robinhood: ROBINHOOD_MIN_ORDER_NOTIONAL
};

/** The per-broker minimum order notional for `activeBroker`, or undefined when none is known. */
export function brokerMinOrderNotional(activeBroker: TradingPolicy["activeBroker"]): number | undefined {
  if (!activeBroker) return undefined;
  return BROKER_MIN_ORDER_NOTIONAL[activeBroker];
}

/**
 * A whole-share (integer quantity >= 1) order is placed and sized in shares, not dollars, so a
 * broker's dollar/fractional minimum does not apply to it even if the resulting notional happens to
 * be small (e.g. one share of a sub-$1 stock). Only dollar-amount or fractional-quantity orders are
 * candidates for the notional-floor fallback below.
 */
function isFractionalOrDollarBased(order: { quantity?: number; dollarAmount?: number }): boolean {
  const wholeShare = order.quantity != null && Number.isInteger(order.quantity) && order.quantity >= 1;
  if (wholeShare) return false;
  return (order.dollarAmount != null && order.dollarAmount > 0) || (order.quantity != null && order.quantity > 0);
}

// Float-quantity comparison tolerance for "does this order's quantity match the FULL held
// position" — fractional share quantities carried through a broker/portfolio snapshot can differ
// by a tiny rounding amount even when they represent the same "whole position."
const FULL_POSITION_QTY_EPSILON = 1e-6;

/**
 * True when `order` is a sell/cover whose `quantity` matches the caller-supplied
 * `positionQuantity` (the account's currently held quantity for this symbol) within
 * FULL_POSITION_QTY_EPSILON — i.e. an order that closes the ENTIRE position rather than a partial
 * trim. Robinhood explicitly permits liquidating a whole fractional position regardless of its
 * dollar value (that's how "dust" positions get cleaned up), and its own `order_checks` pre-flight
 * does not flag those — so this exemption only ever applies to our OWN defensive notional-floor
 * fallback below, never overrides an actual `review.preflightBlock` signal from the broker.
 *
 * Both `side` and `positionQuantity` are optional on the order shape: existing call sites that
 * don't supply them simply never match here, preserving today's blocking behavior unchanged until
 * a caller threads the position quantity through.
 */
function isFullPositionExit(order: { quantity?: number; side?: OrderSide; positionQuantity?: number }): boolean {
  if (order.side !== "sell" && order.side !== "cover") return false;
  if (order.quantity == null || order.positionQuantity == null) return false;
  if (!(order.positionQuantity > 0)) return false;
  return Math.abs(order.quantity - order.positionQuantity) <= FULL_POSITION_QTY_EPSILON;
}

/**
 * Returns a human-readable block reason when `review` shows this order is a GUARANTEED reject for
 * being below the active broker's minimum order size — either because the broker's own pre-flight
 * review already flagged it (`review.preflightBlock`, the authoritative signal) or, as a defensive
 * fallback for a fractional/dollar-based order whose reviewed notional is itself under the known
 * per-broker floor. Returns undefined for anything else — this must never flag a legitimate order.
 *
 * EXEMPTION: a sell/cover that closes the entire position (`order.quantity` == `order.positionQuantity`,
 * epsilon tolerance) is never blocked by the notional-floor fallback — see `isFullPositionExit`'s
 * doc comment. A genuinely sub-minimum PARTIAL trim (quantity less than the held position) is
 * unaffected and still blocked exactly as before.
 */
export function describeBrokerMinimumOrderBlock(
  review: ReviewedOrder,
  activeBroker: TradingPolicy["activeBroker"],
  order: { quantity?: number; dollarAmount?: number; side?: OrderSide; positionQuantity?: number }
): string | undefined {
  if (review.preflightBlock?.alertTypes?.length) {
    return `Broker pre-flight rejects this order: ${review.preflightBlock.message}`;
  }
  const minNotional = brokerMinOrderNotional(activeBroker);
  if (
    minNotional !== undefined &&
    review.estimatedNotional > 0 &&
    review.estimatedNotional < minNotional &&
    isFractionalOrDollarBased(order) &&
    !isFullPositionExit(order)
  ) {
    return `Order notional $${review.estimatedNotional.toFixed(2)} is below the broker's $${minNotional.toFixed(2)} minimum order size and would be rejected.`;
  }
  return undefined;
}

const SUB_MINIMUM_ALERT_COOLDOWN_PREFIX = "subMinimumOrderAlertSent";
// This condition is NAV-bound and persistent (it will not clear itself run to run like a transient
// outage), so there's no value in re-alerting every hour — one alert per window is plenty until the
// owner acts (raise the trim/order size, trim manually, or ignore).
const SUB_MINIMUM_ALERT_COOLDOWN_MS = 24 * 60 * 60_000; // 24 hours

/**
 * Cooldown-gated: returns true (and marks the cooldown) at most once per (accountNumber, symbol)
 * per `SUB_MINIMUM_ALERT_COOLDOWN_MS` window — mirrors the HEALTH_ALERT_COOLDOWN /
 * STORAGE_ALERT_COOLDOWN pattern in db-health.ts. Callers must still skip placing the order
 * regardless of this return value; it only gates whether an outward alert/notification fires this run.
 */
export function shouldAlertBrokerMinimumOrderBlock(accountNumber: string, symbol: string): boolean {
  const key = `${SUB_MINIMUM_ALERT_COOLDOWN_PREFIX}:${accountNumber}:${symbol}`;
  const last = getInternalSetting<string>(key);
  if (last && Date.now() - Date.parse(last) < SUB_MINIMUM_ALERT_COOLDOWN_MS) return false;
  setInternalSetting(key, new Date().toISOString());
  return true;
}
