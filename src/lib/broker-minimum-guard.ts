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
  // Short positions are stored with NEGATIVE quantities — a full COVER must qualify for the
  // exemption exactly like a full sell, so compare magnitudes.
  const held = Math.abs(order.positionQuantity);
  if (!(held > 0)) return false;
  return Math.abs(order.quantity - held) <= FULL_POSITION_QTY_EPSILON;
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

// Robinhood accepts fractional quantities up to 6 decimal places; bump rounding is done UP at this
// precision so the bumped order can never land back under the floor from rounding alone.
const FRACTIONAL_QTY_PRECISION = 1e6;

// Headroom applied when bumping a QUANTITY-based fractional order: the price can drift between our
// review and the broker's execution-time check, and a bump to exactly $1.00 of stock would flip back
// under the floor on any downtick. 2% is pennies at this order size and kills the flakiness.
// Dollar-based orders need no headroom — the broker executes the literal dollar amount.
const BUMP_PRICE_DRIFT_HEADROOM = 1.02;

/**
 * How a below-broker-minimum order is resolved (owner ruling 2026-07-09: bump is the default):
 *  - "bump": resize the order UP to the broker's minimum so it can actually execute. The bumped
 *    order is re-reviewed and then flows through the FULL policy gate (per-order caps, NAV%, daily
 *    notional, buying power) at its bumped size — so a bump can never over-size past the owner's
 *    caps; if the floor itself violates a cap, the normal policy engine blocks it with an honest
 *    reason. A sell/cover whose bump would meet or exceed the whole held position becomes a
 *    full-position exit instead (brokers permit liquidating dust below the minimum) — but ONLY
 *    when the original order's quantity was within the held position; an order that already asks
 *    for more than is held blocks instead (it would have been rejected by the policy engine's
 *    holdings check un-bumped, and a bump must never upgrade that reject into a liquidation).
 *  - "skip": the pre-2026-07-09 behavior — don't place a guaranteed-reject order, record + alert.
 */
export type BrokerMinimumResolution =
  | { action: "proceed" }
  | { action: "block"; reason: string }
  | {
      action: "bump";
      /** Patch to apply to the order before re-review: exactly one of these is set. */
      patch: { dollarAmount: number; quantity?: undefined } | { quantity: number; dollarAmount?: undefined };
      /** True when the bump was capped at the whole held position (now an exempt full exit). */
      becomesFullExit: boolean;
      /** Human-readable record of what changed, for the audit trail. */
      note: string;
    };

/**
 * Decides what to do with an order relative to the active broker's minimum order size, honoring the
 * owner's `brokerMinimumHandling` policy. Returns "proceed" when the order isn't below-minimum at
 * all (including whole-share orders and exempt full-position dust exits — same semantics as
 * `describeBrokerMinimumOrderBlock`). NOTE: `review.preflightBlock` is minimum-specific by
 * construction (robinhood.ts filters `order_checks` to ROBINHOOD_SUB_MINIMUM_ALERT_TYPES before
 * setting it), so a bump is a legitimate response to it; if the floor for the broker is unknown, we
 * can't compute a bump and fail safe to block.
 *
 * Callers that receive "bump" MUST re-review the patched order and re-run this function on the
 * fresh review exactly once — if it still resolves below-minimum (price collapsed mid-run), block
 * rather than loop.
 */
export function resolveBrokerMinimum(
  review: ReviewedOrder,
  activeBroker: TradingPolicy["activeBroker"],
  order: { quantity?: number; dollarAmount?: number; side?: OrderSide; positionQuantity?: number; positionMarketValue?: number },
  mode: "bump" | "skip"
): BrokerMinimumResolution {
  const reason = describeBrokerMinimumOrderBlock(review, activeBroker, order);
  if (!reason) return { action: "proceed" };
  if (mode === "skip") return { action: "block", reason };

  const minNotional = brokerMinOrderNotional(activeBroker);
  if (minNotional === undefined) {
    // preflightBlock fired but we don't know this broker's floor — no number to bump to.
    return { action: "block", reason };
  }

  // Dollar-based order: the broker executes the literal amount, so the exact floor suffices.
  // (Defensive: an order carrying BOTH a whole-share integer quantity and a dollarAmount must not
  // be silently re-based onto dollars — fail safe to block instead. Shouldn't occur in practice.)
  const carriesWholeShareQty = order.quantity != null && Number.isInteger(order.quantity) && order.quantity >= 1;
  if (order.dollarAmount != null && order.dollarAmount > 0 && !carriesWholeShareQty) {
    if (order.side === "sell" || order.side === "cover") {
      // A dollar-based trim can't be bumped past what the position is worth: a $1.00 sell of a
      // $0.70 position is exactly the guaranteed-reject (or unintended full liquidation) this
      // module exists to prevent, and the policy engine's holdings checks no-op on dollar orders.
      // NOTE: like the full-exit exemption above, this cap only engages for LONG positions
      // (positionQuantity > 0) — shorts carry negative quantity, so covers fall through to the
      // fail-safe below until a caller threads short-position semantics through explicitly.
      if (
        order.positionQuantity != null &&
        order.positionQuantity > 0 &&
        order.positionMarketValue != null &&
        order.positionMarketValue > 0 &&
        order.positionMarketValue <= minNotional * BUMP_PRICE_DRIFT_HEADROOM
      ) {
        // The whole position sits at/under the floor (+headroom): bumping a partial dollar trim is
        // impossible, so convert to a full-position share exit — brokers permit liquidating an
        // entire fractional position below the minimum (the same dust-exit exemption as above).
        return {
          action: "bump",
          patch: { quantity: order.positionQuantity },
          becomesFullExit: true,
          note: `Converted $${order.dollarAmount.toFixed(2)} ${order.side} to a full-position exit of ${order.positionQuantity} shares (position ~$${order.positionMarketValue.toFixed(2)} is at/below the broker's $${minNotional.toFixed(2)} minimum).`
        };
      }
      if (order.positionMarketValue == null || !(order.positionMarketValue > 0)) {
        // Can't prove the bumped dollar amount fits inside the held position — fail safe.
        return { action: "block", reason };
      }
    }
    return {
      action: "bump",
      patch: { dollarAmount: minNotional },
      becomesFullExit: false,
      note: `Bumped dollar amount $${order.dollarAmount.toFixed(2)} -> $${minNotional.toFixed(2)} (broker minimum).`
    };
  }

  // Fractional quantity order: derive the per-share price from the review's own notional estimate.
  if (order.quantity != null && order.quantity > 0 && review.estimatedNotional > 0) {
    const price = review.estimatedNotional / order.quantity;
    let bumpedQty = Math.ceil(((minNotional * BUMP_PRICE_DRIFT_HEADROOM) / price) * FRACTIONAL_QTY_PRECISION) / FRACTIONAL_QTY_PRECISION;
    let becomesFullExit = false;
    // NOTE: the "cover" arm here (and in the exemption above) is effectively long-only today —
    // short positions carry NEGATIVE quantity, so positionQuantity > 0 never holds for a short and
    // covers fall through to a plain bump. Deliberate parity with isFullPositionExit; revisit if a
    // caller ever threads absolute short-position quantities through.
    if (
      (order.side === "sell" || order.side === "cover") &&
      order.positionQuantity != null &&
      order.positionQuantity > 0
    ) {
      if (order.quantity > order.positionQuantity + FULL_POSITION_QTY_EPSILON) {
        // The ORIGINAL order already asks for more than is held. Un-bumped, the policy engine's
        // sellQuantityExceedsHoldings check (policy.ts) would deterministically reject it as a
        // correctness error — and any bumped quantity is strictly larger, so a bump can only
        // launder a malformed/stale-holdings order into a full liquidation the proposal never
        // asked for. Fail safe to block (honest below-minimum record), matching the guard's
        // other unbumpable paths.
        return { action: "block", reason };
      }
      if (bumpedQty >= order.positionQuantity - FULL_POSITION_QTY_EPSILON) {
        // Selling at least the whole position — cap at the position and let the dust-exit
        // exemption carry it (brokers permit whole-position liquidation below the minimum).
        bumpedQty = order.positionQuantity;
        becomesFullExit = true;
      }
    }
    if (!(bumpedQty > order.quantity) && !becomesFullExit) {
      // Degenerate: bump math produced no increase (shouldn't happen when reason fired) — fail safe.
      return { action: "block", reason };
    }
    return {
      action: "bump",
      patch: { quantity: bumpedQty },
      becomesFullExit,
      note: becomesFullExit
        ? `Bumped quantity ${order.quantity} -> ${bumpedQty} (whole position; broker-minimum bump met the full held quantity, exempt as a full exit).`
        : `Bumped quantity ${order.quantity} -> ${bumpedQty} (~$${(bumpedQty * price).toFixed(2)}) to clear the broker's $${minNotional.toFixed(2)} minimum.`
    };
  }

  // No usable sizing basis (no dollar amount, and no quantity/price to scale) — fail safe.
  return { action: "block", reason };
}

const SUB_MINIMUM_ALERT_COOLDOWN_PREFIX = "subMinimumOrderAlertSent";
// This condition is NAV-bound and persistent (it will not clear itself run to run like a transient
// outage), so there's no value in re-alerting every hour — one alert per window is plenty until the
// owner acts (raise the trim/order size, trim manually, or ignore).
const SUB_MINIMUM_ALERT_COOLDOWN_MS = 24 * 60 * 60_000; // 24 hours

/**
 * Cooldown-gated: returns true (and marks the cooldown) at most once per (user, accountNumber, symbol)
 * per `SUB_MINIMUM_ALERT_COOLDOWN_MS` window — mirrors the HEALTH_ALERT_COOLDOWN /
 * STORAGE_ALERT_COOLDOWN pattern in db-health.ts. Callers must still skip placing the order
 * regardless of this return value; it only gates whether an outward alert/notification fires this run.
 */
export function shouldAlertBrokerMinimumOrderBlock(userId: string, accountNumber: string, symbol: string): boolean {
  const key = `${SUB_MINIMUM_ALERT_COOLDOWN_PREFIX}:${userId}:${accountNumber}:${symbol}`;
  const last = getInternalSetting<string>(key);
  if (last && Date.now() - Date.parse(last) < SUB_MINIMUM_ALERT_COOLDOWN_MS) return false;
  setInternalSetting(key, new Date().toISOString());
  return true;
}
