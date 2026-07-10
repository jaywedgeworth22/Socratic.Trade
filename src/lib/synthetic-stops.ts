import crypto from "crypto";
import {
  advanceSyntheticStopGeneration,
  audit,
  claimSyntheticStop,
  dailyExecutionStats,
  deleteSyntheticStop,
  getActiveConnectedAccount,
  insertFillEvent,
  listBrokerProtectiveStops,
  listPendingBrokerReconciliationFills,
  listSyntheticStops,
  recordSyntheticStopAttempt,
  revertSyntheticStopClaim,
  upsertSyntheticStop,
  type SyntheticTrailingStop
} from "./db";
import { getBrokerGateway } from "./broker";
import { isLiveExitOrder, isLiveOrderState, isRejectedOrCanceledState, liveExitOrderCoverage } from "./broker-side";
import { applyPaperExitCost } from "./execution-cost";
import { cancelBrokerProtectiveStop, reconcileBrokerProtectiveStops } from "./broker-protective-stops";
import { resolveProtectiveExitRouting, type ProtectiveExitQuote } from "./protective-exit-routing";
import { deriveExecutionState } from "./execution-mode";
import { normalizeSymbol } from "./money";
import { evaluateTradeProposal } from "./policy";
import type { EquityOrder, EquityPosition, ExecutionMode, FillSource, TradeProposal, TradingPolicy } from "./types";

const BAD_TICK_PCT = 0.1; // ignore a single print deviating >10% from the last good price

// isLiveExitOrder / liveExitOrderCoverage moved to broker-side.ts (2026-07-10) so the broker-held
// protective-stop reconciler can share the same quantity-aware coverage rules without an import
// cycle. Semantics unchanged — see their doc comments there.

// A 'triggered' stop may only re-arm after this long without any sign of its exit order — long
// enough that a slow in-flight placement (broker call spanning ticks) or a lagging position/order
// feed can't race a re-arm into a duplicate exit.
const REARM_CONFIRM_GRACE_MS = 15 * 60_000;

// Share-count tolerance for coverage comparisons (mirrors the position-size epsilon used below).
const QTY_EPSILON = 0.000001;

export interface StopEvaluation {
  newExtreme: number;
  triggerPrice: number;
  triggered: boolean;
  badTick: boolean;
}

/**
 * Pure trailing-stop evaluation (R2 §2.5). Given a stop and a fresh price, returns the updated
 * extreme (high-watermark for a long, low for a short), the trail trigger price, whether it has
 * triggered, and whether the print looks like a bad tick (>10% off the last good price) — which is
 * ignored so a single spurious print can neither move the trail nor fire an exit.
 */
export function evaluateStop(
  stop: Pick<SyntheticTrailingStop, "side" | "extremePrice" | "trailPercent" | "trailAmount" | "lastPrice">,
  price: number
): StopEvaluation {
  const prev = stop.lastPrice;
  const badTick = prev != null && prev > 0 && Math.abs(price - prev) / prev > BAD_TICK_PCT;
  const newExtreme = badTick
    ? stop.extremePrice
    : stop.side === "long"
      ? Math.max(stop.extremePrice, price)
      : Math.min(stop.extremePrice, price);
  const triggerPrice =
    stop.side === "long"
      ? stop.trailPercent != null
        ? newExtreme * (1 - stop.trailPercent / 100)
        : newExtreme - (stop.trailAmount ?? 0)
      : stop.trailPercent != null
        ? newExtreme * (1 + stop.trailPercent / 100)
        : newExtreme + (stop.trailAmount ?? 0);
  const triggered = !badTick && price > 0 && (stop.side === "long" ? price <= triggerPrice : price >= triggerPrice);
  return { newExtreme, triggerPrice, triggered, badTick };
}

export interface MonitorResult {
  evaluated: number;
  triggered: number;
  exited: number;
  purged: number;
}

/**
 * Synthetic trailing-stop monitor (works for any broker, incl. Robinhood MCP). Detection — extreme
 * tracking, trigger computation, bad-tick filtering — is always safe. Placing the market EXIT only
 * happens when `running` is true (the system was deliberately Started or is in a protective state
 * such as close_only/liquidating). Purges stops for positions that have closed, and auto-registers
 * a stop for each open position when `policy.riskRules.trailingStopPct` is configured and none
 * exists yet.
 */
export async function runSyntheticStopMonitor(userId: string, policy: TradingPolicy, running: boolean): Promise<MonitorResult> {
  const result: MonitorResult = { evaluated: 0, triggered: 0, exited: 0, purged: 0 };
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return result;

  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  // An account is an account: with none connected there is no broker to protect against.
  if (!executionState.mode) return result;
  const executionMode: ExecutionMode = executionState.mode;
  const gateway = getBrokerGateway(policy, userId);
  const source: FillSource = executionMode === "broker/live" ? "live" : "paper";

  let positions: EquityPosition[];
  try {
    positions = await gateway.getEquityPositions(accountNumber);
  } catch {
    return result; // can't evaluate safely without positions
  }
  const liveSymbols = new Set(positions.filter((p) => Math.abs(p.quantity) > 0.000001).map((p) => normalizeSymbol(p.symbol)));

  // Live open orders for the account, feeding the coverage checks below. A broker-held stop
  // (Alpaca OCO bracket leg, Robinhood broker-held protective stop) is a live exit-side order, so
  // the quantity-aware liveExitOrderCoverage counts it as protection — keyed off ACTUAL resting
  // orders (not policy inference) so a position is never left unprotected. If listing orders fails,
  // coverage sees no orders and the synthetic still registers below (protection over dedup).
  let brokerOrders: EquityOrder[] = [];
  let brokerOrdersListed = false;
  try {
    brokerOrders = await gateway.getEquityOrders(accountNumber);
    brokerOrdersListed = true;
  } catch {
    // Can't list orders — fall back to registering synthetic stops (protection over dedup).
  }
  // The account's OWN recognized broker-held protective stop for a symbol (broker_protective_stops,
  // keyed by its actual brokerOrderId) — populated AFTER reconcileBrokerProtectiveStops runs below,
  // so it reflects this tick's placements/cancellations. Excluded from the quantity-BLIND sweep just
  // below: it is separately-tracked, independently-managed coverage (possibly for OTHER shares of
  // the same symbol, e.g. a native trail covering the floored whole-share portion while the
  // synthetic monitor covers a fractional remainder) — it must never be mistaken for "our own
  // synthetic exit attempt might still be alive" (Codex review, PR #1331).
  // Populated from the DB now (state left by the END of the PREVIOUS tick's reconcile) so the
  // re-arm pass below — which runs BEFORE this tick's reconcile call — already excludes it;
  // refreshed again after reconcile runs (below) to reflect any placement/cancellation THIS tick
  // made, for the fire pass later in this same call.
  let brokerHeldOrderIdBySymbol = new Map<string, string>(
    listBrokerProtectiveStops(accountNumber, userId).map((r) => [normalizeSymbol(r.symbol), r.brokerOrderId])
  );
  // Quantity-BLIND presence check — used only by the confirmed-terminal gate, where ANY live exit
  // order OTHER than the account's own recognized broker-held stop (excluded above) must block a
  // generation advance: while anything unaccounted-for is still working for the symbol — including
  // our own synthetic attempt, if its order lacks a matchable client_order_id — we cannot positively
  // rule the prior attempt dead. Registration and firing use the quantity-AWARE liveExitOrderCoverage
  // instead, so a 10-of-100-share trim can't leave the other 90 shares unprotected forever.
  const hasAnyLiveExitOrder = (symbol: string, positionSide: "long" | "short"): boolean =>
    brokerOrders.some(
      (o) =>
        normalizeSymbol(o.symbol) === symbol &&
        isLiveExitOrder(o, positionSide) &&
        o.id !== brokerHeldOrderIdBySymbol.get(symbol)
    );
  const isLiveState = (state: string): boolean => isLiveOrderState(state);

  // Synthetic protective exits whose outcome hasn't been reconciled yet (booked pending at
  // placement, finalized by reconcilePendingFills from broker truth). While one is pending for a
  // symbol, that exit may still have executed — never treat the attempt as dead.
  const pendingExitSymbols = new Set(
    listPendingBrokerReconciliationFills(accountNumber, userId)
      .filter((f) => Boolean((f.raw as Record<string, unknown> | undefined)?.syntheticStop))
      .map((f) => normalizeSymbol(f.symbol))
  );

  /**
   * POSITIVE confirmation that the prior protective-exit attempt's order is dead — the ONLY state in
   * which fire_generation may advance (rolling the client_order_id forward is safe exactly when the
   * old id's order can no longer execute). Layered, and ambiguity always fails to `false`:
   *  - the broker's order list was successfully fetched THIS tick (a failed fetch proves nothing);
   *  - it shows no live exit order for the symbol OTHER than the account's own recognized
   *    broker-held stop (see `brokerHeldOrderIdBySymbol` above) — that ONE specific order is
   *    excluded because it's separately-tracked, independently-managed coverage, so a
   *    coverage-aware PARTIAL fire (the synthetic sells only the remainder a broker-held stop
   *    doesn't cover) can coexist with it without blocking re-arm of the remainder's own dead
   *    attempt forever. Anything else live — including our OWN synthetic exit order, if its
   *    client_order_id happens not to be matchable below — still blocks (Codex review, PR #1331,
   *    two rounds: neither a pure symbol-wide sweep nor a pure client_order_id match alone is
   *    correct; excluding only the one order we can independently identify by broker-tracked id is);
   *  - the recorded last_attempt_ref_id (if any) appears in no live-state order, matched by
   *    client_order_id directly — belt-and-suspenders on top of the exclusion above, in case the
   *    excluded broker-held row and our own last attempt were somehow the same order;
   *  - no synthetic-exit fill for the symbol is still pending reconciliation;
   *  - (re-arm pass only) the row is older than the 15-min grace, so a slow in-flight placement
   *    spanning ticks can't race a re-arm. The grace is keyed off updated_at, which for ACTIVE rows
   *    is refreshed by the per-tick extreme persistence — so the fire path must not require it, or a
   *    reverted-after-throw stop could never roll its id forward (the permanent-422 loop again).
   */
  const confirmedPriorExitDead = (stop: SyntheticTrailingStop, requireGrace: boolean): boolean => {
    if (!brokerOrdersListed) return false;
    const sym = normalizeSymbol(stop.symbol);
    if (hasAnyLiveExitOrder(sym, stop.side)) return false;
    if (stop.lastAttemptRefId && brokerOrders.some((o) => o.clientOrderId === stop.lastAttemptRefId && isLiveState(o.state))) return false;
    if (pendingExitSymbols.has(sym)) return false;
    if (requireGrace && Date.now() - Date.parse(stop.updatedAt) < REARM_CONFIRM_GRACE_MS) return false;
    return true;
  };

  // Purge stops whose position has closed (size hit 0) — including 'triggered' ones, whose exit
  // order has by then done its job. A lingering triggered row would otherwise block auto-registering
  // a fresh stop if the symbol is re-entered later.
  for (const stop of [...listSyntheticStops(accountNumber, userId), ...listSyntheticStops(accountNumber, userId, "triggered")]) {
    if (!liveSymbols.has(stop.symbol.toUpperCase())) {
      deleteSyntheticStop(stop.id, userId);
      result.purged++;
    }
  }

  // Re-arm 'triggered' stops whose protective exit order is confirmed dead while the position is
  // still open (canceled/expired/rejected without closing it — or terminal after only a partial).
  // Confirmation is the strict layered check above (order list visible, no live exit order, the
  // recorded client_order_id in no live state, nothing pending reconciliation, 15-min grace).
  // Anything short of that leaves the stop 'triggered' — never re-fire on top of an exit that may
  // still execute. On confirmation the generation advances (this is the positive-confirmation
  // moment), so the next fire places under a fresh "-g<n>" client_order_id instead of 422-colliding
  // with the dead order's id forever.
  if (brokerOrdersListed) {
    for (const stop of listSyntheticStops(accountNumber, userId, "triggered")) {
      if (!liveSymbols.has(normalizeSymbol(stop.symbol))) continue; // position closed — purged above
      if (!confirmedPriorExitDead(stop, true)) continue;
      advanceSyntheticStopGeneration(stop.id, userId);
      revertSyntheticStopClaim(stop.id, userId);
      audit("synthetic_stop_rearmed", {
        symbol: stop.symbol,
        side: stop.side,
        fireGeneration: stop.fireGeneration + 1,
        note: "protective exit order confirmed terminal with the position still open — trailing protection restored"
      }, userId, policy.connectedAccountId);
    }
  }

  // Broker-held protective stops: fixed resting stops for open longs (Robinhood, opt-in) and/or
  // broker-held TRAILING stops (native Alpaca trailing_stop; tick-ratcheted stop-market on live
  // Robinhood) when a trailing % is configured — cancelled on close. No-op unless a lane is enabled
  // (see desiredBrokerStopKind in broker-protective-stops.ts).
  // Orders it CANCELS (e.g. the disabled-teardown) are pruned from the list REGISTRATION coverage
  // uses: brokerOrders was fetched before this reconcile ran, so a just-torn-down stop would
  // otherwise still look live and leave the position with NEITHER protection until the next tick.
  // Symbols it PLACED stops for this tick are the mirror-image staleness: the fresh resting order
  // CANNOT appear in the pre-reconcile list, so BOTH synthetic registration AND the fire path of
  // already-registered rows treat them as broker-covered for this tick (see the two
  // justPlacedBrokerStopSymbols skips below) instead of acting on an undercount. For CANCELLED
  // orders the fire and confirmed-dead paths keep the UNpruned list on purpose — a cancel the
  // broker merely accepted can still fill, and there a stale skip costs one tick while a wrong fire
  // costs a duplicate market sell.
  let registrationOrders = brokerOrders;
  // Full-size placements suppress BOTH synthetic registration and fire this tick (the fresh order
  // can't appear in the stale pre-reconcile list). Partial placements (a floored fractional
  // remainder, or shares partially covered by another exit order) suppress registration (a row
  // already exists) but must NOT blanket-skip the fire path — the fresh partial quantity is added
  // as KNOWN coverage on top of the stale order list's own coverage, so the fire path can still sell
  // the uncovered remainder this same tick instead of leaving it naked until the next tick's fresh
  // order fetch (Codex review, PR #1331).
  const justPlacedBrokerStopSymbols = new Set<string>();
  const justPlacedPartialBrokerStopQty = new Map<string, number>();
  // The app's own already-tracked high-water mark per symbol (ACTIVE rows only — a purged/triggered
  // row's extreme isn't live protection). Passed into reconcile so a broker-held trail is never
  // seeded looser than the trail already protecting the position after a rally-then-pullback.
  const extremePriceBySymbol = Object.fromEntries(
    listSyntheticStops(accountNumber, userId).map((s) => [normalizeSymbol(s.symbol), s.extremePrice])
  );
  try {
    const reconciled = await reconcileBrokerProtectiveStops({ userId, policy, accountNumber, gateway, positions, executionMode, running, orders: brokerOrders, ordersListed: brokerOrdersListed, extremePriceBySymbol });
    if (reconciled.cancelledOrderIds.length > 0) {
      const cancelledIds = new Set(reconciled.cancelledOrderIds);
      registrationOrders = brokerOrders.filter((o) => !cancelledIds.has(o.id));
    }
    for (const sym of reconciled.placedStopSymbols) justPlacedBrokerStopSymbols.add(normalizeSymbol(sym));
    for (const sym of reconciled.partiallyPlacedStopSymbols) {
      const s = normalizeSymbol(sym);
      justPlacedPartialBrokerStopQty.set(s, reconciled.partiallyPlacedStopQuantities[sym] ?? reconciled.partiallyPlacedStopQuantities[s] ?? 0);
    }
    // A broker-held stop that FILLED between this call's position fetch and reconcile's own order
    // read reduced the position, but `positions` above was captured before `orders` — it may still
    // show the stale pre-fill quantity THIS call. Treat these symbols exactly like a fresh full-size
    // placement: skip both registration and fire this tick, deferring to the next call's fresh
    // position read (Codex review, PR #1331) — otherwise the synthetic monitor could auto-register
    // or fire a market exit against shares the broker stop already sold.
    for (const sym of reconciled.filledRecoverySymbols) justPlacedBrokerStopSymbols.add(normalizeSymbol(sym));
  } catch (err) {
    audit("broker_protective_stop_reconcile_error", { error: err instanceof Error ? err.message : String(err) }, userId, policy.connectedAccountId);
  }
  // Refresh the account's own recognized broker-held stop per symbol AFTER reconcile ran, so
  // `hasAnyLiveExitOrder`'s exclusion (see its doc comment) reflects any placement/cancellation
  // reconcile just made this tick.
  brokerHeldOrderIdBySymbol = new Map(
    listBrokerProtectiveStops(accountNumber, userId).map((r) => [normalizeSymbol(r.symbol), r.brokerOrderId])
  );

  // Auto-register a trailing stop for each open position when a trail % is configured.
  // Longs trail from a high-watermark and exit with a sell; shorts (only when short
  // selling is enabled) trail from a low-watermark and exit with a cover.
  const trailPct = policy.riskRules?.trailingStopPct ?? 0;
  if (trailPct > 0) {
    // "Already protected" includes TRIGGERED stops: a triggered stop's exit order may still be
    // resting at the broker (e.g. a market sell placed after hours). Re-registering over it flipped
    // the row back to 'active' and re-fired the same stop every tick all night (MU, 2026-07-08).
    const existing = new Set(
      [...listSyntheticStops(accountNumber, userId), ...listSyntheticStops(accountNumber, userId, "triggered")]
        .map((s) => s.symbol.toUpperCase())
    );
    for (const pos of positions) {
      const sym = normalizeSymbol(pos.symbol);
      if (Math.abs(pos.quantity) <= 0.000001 || existing.has(sym)) continue;
      const isShort = pos.quantity < 0;
      if (isShort && !policy.shortSellingEnabled) continue;
      // Reconcile PLACED (or cancel/REPLACED) a broker-held protective stop for this symbol THIS
      // tick. That fresh full-size stop cannot appear in the pre-reconcile order list, so the
      // coverage check below would undercount — the synthetic would register against stale
      // coverage, and if the quote already breaches the trail it would fire the same tick, selling
      // shares the replacement already covers and then cancelling that replacement
      // (cancelBrokerProtectiveStop after the fill booking), leaving the remainder unprotected
      // until the re-arm grace. Treat the symbol as broker-covered for THIS tick; the next tick's
      // fresh order fetch sees the real resting order and normal quantity-aware coverage takes
      // over. The fire path of ALREADY-registered rows carries the same gate (see the fire loop
      // below): an active row armed on an earlier tick (e.g. one where placement threw, or before
      // the feature was enabled) would otherwise fire against the same undercount and then cancel
      // the fresh stop.
      if (justPlacedBrokerStopSymbols.has(sym)) continue;
      // Live open exit orders (market/limit/stop — a full-size broker-held stop leg included) are
      // protection — but only for the shares they actually cover. Skip registering ONLY when the
      // whole position is covered (or a live exit order's quantity is unknowable — then assume full
      // coverage, failing toward no-duplicate-sell). A partial exit (e.g. a 10-of-100-share GTC
      // take-profit trim, or an undersized broker stop) must NOT leave the remaining shares
      // trailing-stop-less through a crash: the stop registers, and the fire path below sells only
      // the uncovered remainder. Re-checked every tick.
      const coverage = liveExitOrderCoverage(registrationOrders, sym, isShort ? "short" : "long");
      if (coverage.unknownQty || coverage.coveredQty >= Math.abs(pos.quantity) - QTY_EPSILON) continue;
      const mark = pos.marketValue / pos.quantity; // sign-correct for long (+/+) and short (-/-)
      upsertSyntheticStop({
        id: `synstop-${userId}-${accountNumber}-${sym}`,
        userId,
        accountNumber,
        symbol: sym,
        side: isShort ? "short" : "long",
        quantity: Math.abs(pos.quantity),
        entryPrice: pos.averageCost,
        extremePrice: isShort ? Math.min(mark, pos.averageCost) : Math.max(mark, pos.averageCost),
        trailPercent: trailPct,
        status: "active"
      });
    }
  }

  const stops = listSyntheticStops(accountNumber, userId);
  if (stops.length === 0) return result;

  let quotes: Record<string, { price?: number; bid?: number; ask?: number; syntheticBid?: boolean; syntheticAsk?: boolean; symbol?: string }> = {};
  try {
    quotes = await gateway.getEquityQuotes(accountNumber, stops.map((s) => normalizeSymbol(s.symbol)));
  } catch (err) {
    // API outage fallback: populate quotes with the last known price from database
    console.error("[synthetic-stops] gateway quotes fetch failed, using lastPrice database cache fallback:", err);
    for (const stop of stops) {
      if (stop.lastPrice && stop.lastPrice > 0) {
        quotes[normalizeSymbol(stop.symbol)] = { price: stop.lastPrice, symbol: stop.symbol };
      }
    }
  }
  const priceFor = (sym: string): number | undefined => {
    const q = quotes[sym] ?? quotes[normalizeSymbol(sym)];
    return q && typeof q.price === "number" && q.price > 0 ? q.price : undefined;
  };
  // Quote ref for pricing an extended-hours marketable-limit exit: a SELL anchors to the real BID, a
  // COVER to the real ASK (the composite `price` is ask-biased — Alpaca sets price = ask ?? bid, so a
  // SELL priced off it would rest above the bid and never be marketable). A synthesized
  // (price-derived) spread side never anchors (mirrors the entry marketable-limit guard); the DB
  // lastPrice fallback above carries `price` only, so it degrades to the composite anchor.
  const exitQuoteFor = (sym: string): ProtectiveExitQuote | undefined => {
    const q = quotes[sym] ?? quotes[normalizeSymbol(sym)];
    if (!q) return undefined;
    return { price: q.price, bid: q.syntheticBid ? undefined : q.bid, ask: q.syntheticAsk ? undefined : q.ask };
  };
  for (const stop of stops) {
    const price = priceFor(stop.symbol);
    result.evaluated++;
    if (price == null) continue;

    const evaln = evaluateStop(stop, price);
    // Persist the updated extreme + last good price (a bad tick keeps the previous lastPrice).
    upsertSyntheticStop({ ...stop, extremePrice: evaln.newExtreme, lastPrice: evaln.badTick ? stop.lastPrice : price });
    if (!evaln.triggered) continue;
    result.triggered++;

    if (!running) {
      audit("synthetic_stop_would_trigger", { symbol: stop.symbol, side: stop.side, price, triggerPrice: evaln.triggerPrice, note: "system not running — exit suppressed" }, userId, policy.connectedAccountId);
      continue;
    }

    // Gated execution: fire the protective market exit (sell a long / cover a short).
    const posQty = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(stop.symbol))?.quantity ?? stop.quantity;
    const positionQty = Math.abs(posQty); // order/fill quantity is always a positive magnitude (cover qty for shorts)
    if (positionQty <= QTY_EPSILON) {
      deleteSyntheticStop(stop.id, userId);
      continue;
    }
    // Reconcile PLACED (or cancel/REPLACED) a broker-held protective stop for this symbol THIS
    // tick — the same pre-reconcile-list staleness the registration skip above guards against, but
    // for a row that was ALREADY active (e.g. registered on a tick where section-4 placement threw,
    // or armed before robinhoodBrokerStops was enabled). The coverage check below cannot see the
    // just-placed FULL-size stop, so firing here would sell shares that stop already covers and
    // then cancelBrokerProtectiveStop (after the fill booking) would cancel the fresh stop —
    // duplicate exit, then no protection. Skipping costs one tick of trail responsiveness with
    // full-size broker-held protection resting; the next tick's fresh order fetch restores real
    // quantity-aware coverage. A PARTIAL placement this tick (e.g. a whole-share-only native trail
    // flooring away a fractional remainder) does NOT get this blanket skip — its known quantity is
    // folded into the coverage calculation below instead, so the fire path can still protect the
    // uncovered remainder THIS tick rather than leaving it completely naked until the next tick's
    // fresh order fetch (Codex review, PR #1331).
    const stopSym = normalizeSymbol(stop.symbol);
    if (justPlacedBrokerStopSymbols.has(stopSym)) {
      audit("synthetic_stop_skipped_resting_exit", {
        symbol: stop.symbol,
        positionQty,
        note: "broker-held protective stop placed this tick — resting protection the stale coverage list can't see; deferring fire to next tick's fresh coverage"
      }, userId, policy.connectedAccountId);
      continue;
    }
    // Quantity-aware double-exit guard: shares already covered by live exit orders are broker-held —
    // selling them again is a duplicate exit. Fully covered (or any live exit order with unknowable
    // quantity — assume full coverage, failing toward no-duplicate-sell): skip firing entirely and
    // leave the stop armed — if that order fills the position closes and the stop purges; if it dies
    // the stop can fire on a later tick. Partially covered (e.g. a 10-of-100-share GTC trim, OR a
    // broker-held stop this SAME reconcile just placed for only part of the position): fire for ONLY
    // the uncovered remainder, so the rest of the position isn't left unprotected.
    const coverage = liveExitOrderCoverage(brokerOrders, stopSym, stop.side);
    const justPlacedPartialQty = justPlacedPartialBrokerStopQty.get(stopSym) ?? 0;
    const effectiveCoveredQty = coverage.coveredQty + justPlacedPartialQty;
    if (coverage.unknownQty || effectiveCoveredQty >= positionQty - QTY_EPSILON) {
      audit("synthetic_stop_skipped_resting_exit", {
        symbol: stop.symbol,
        positionQty,
        coveredQty: effectiveCoveredQty,
        unknownOrderQuantity: coverage.unknownQty,
        note: coverage.unknownQty
          ? "a live exit order with unknowable quantity rests for this symbol — treated as fully covering, not stacking another protective exit"
          : "live exit orders (incl. a broker-held stop just placed this tick) already cover the full position — not stacking another protective exit"
      }, userId, policy.connectedAccountId);
      continue;
    }
    const qty = Math.min(positionQty, Math.max(positionQty - effectiveCoveredQty, 0));
    const exitSide = stop.side === "long" ? "sell" : "cover";
    // Route the protective exit: a plain market order that queues to the regular open by default, or a
    // marketable-limit tagged extended_hours when "App stops in extended hours" is on AND we are in the
    // pre/post session (a market order with extended_hours=true is broker-rejected). The limit anchors
    // to the real bid (sell crosses down) / ask (cover crosses up) with the triggering quote as the
    // fallback anchor; a fractional `qty` keeps the market/queue-to-open routing (fractional orders
    // are regular-hours-only — an extended-hours fractional limit would be hard-blocked, not queued).
    const routing = resolveProtectiveExitRouting(policy, exitSide, exitQuoteFor(stop.symbol), undefined, qty);
    const exitProposal: TradeProposal = {
      symbol: normalizeSymbol(stop.symbol),
      side: exitSide,
      type: routing.type,
      quantity: qty,
      limitPrice: routing.limitPrice,
      timeInForce: "gfd",
      marketHours: routing.marketHours,
      rationale: "Synthetic trailing stop fired from the protective scheduler.",
      tradeThesisTag: "Synthetic Stop",
      entryMarketRegime: "Risk Exit"
    };
    const tradability = await gateway.getEquityTradability(accountNumber, [exitProposal.symbol]).catch((err) => {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reason: "tradability_check_failed", error: err instanceof Error ? err.message : String(err) }, userId, policy.connectedAccountId);
      return undefined;
    });
    if (!tradability?.[exitProposal.symbol]?.tradable) {
      audit("synthetic_stop_blocked", {
        symbol: stop.symbol,
        reason: tradability?.[exitProposal.symbol]?.reason ?? "Symbol is not tradable for the protective exit."
      }, userId, policy.connectedAccountId);
      continue;
    }
    const portfolio = await gateway.getPortfolio(accountNumber).catch((err) => {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reason: "portfolio_check_failed", error: err instanceof Error ? err.message : String(err) }, userId, policy.connectedAccountId);
      return undefined;
    });
    if (!portfolio) continue;
    const daily = dailyExecutionStats(accountNumber, new Date(), userId);
    const policyDecision = evaluateTradeProposal(exitProposal, {
      policy,
      portfolio,
      positions,
      dailyNotionalUsed: daily.notional,
      dailyOrderCount: daily.openingOrderCount,
      estimatedNotional: qty * price,
      isLiveExecution: executionMode === "broker/live"
    });
    if (!policyDecision.approved) {
      audit("synthetic_stop_blocked", { symbol: stop.symbol, reasons: policyDecision.reasons }, userId, policy.connectedAccountId);
      continue;
    }
    // Atomically claim this stop (active -> triggered) BEFORE placing. If a previous tick's
    // monitor is still mid-placement (slow broker call spanning the next 60s tick), it already
    // claimed the stop and this run skips it — so the same protective exit can't fire twice. The
    // claim also serializes the generation/refId bookkeeping below against concurrent monitor runs.
    if (!claimSyntheticStop(stop.id, userId)) {
      audit("synthetic_stop_skipped_inflight", { symbol: stop.symbol, note: "already claimed/triggered by a concurrent monitor run" }, userId, policy.connectedAccountId);
      continue;
    }
    // Deterministic ref id (stop id + trigger price + fire generation) so the broker's own
    // client_order_id dedupe stays the LAST-RESORT double-sell guard:
    //  - A row with NO last_attempt_ref_id has no possibly-live prior order; its id comes from the
    //    row's fire_generation ("-g<n>" appended only when > 0, so a first-generation fire keeps the
    //    original unsuffixed id format and dedupe semantics unchanged).
    //  - A row that still CARRIES last_attempt_ref_id was reverted after an uncertain placement
    //    (threw after the broker may have accepted — no fill was booked). Only on POSITIVE
    //    confirmation that that order is dead (the same layered check the re-arm pass uses; no
    //    time grace here — see confirmedPriorExitDead for why updated_at can't gate active rows)
    //    does the generation advance and a fresh id get computed. Anything ambiguous — order list
    //    fetch failed, the old id or any exit order still live, a fill still pending — reuses the
    //    recorded id VERBATIM, so if the prior order is alive at the broker the retry 422s instead
    //    of double-selling. Failing safe here is the whole point: a 422 costs a tick; a duplicate
    //    market sell costs money.
    // The id is persisted (recordSyntheticStopAttempt) BEFORE the broker call, so even a placement
    // that throws mid-flight leaves a durable record of the possibly-live order.
    let generation = stop.fireGeneration;
    let refId: string | undefined;
    if (stop.lastAttemptRefId) {
      if (confirmedPriorExitDead(stop, false)) {
        advanceSyntheticStopGeneration(stop.id, userId);
        generation += 1;
      } else {
        refId = stop.lastAttemptRefId;
      }
    }
    refId ??= `sstop-${stop.id}-${Math.round(evaln.triggerPrice * 100)}${generation > 0 ? `-g${generation}` : ""}`;
    recordSyntheticStopAttempt(stop.id, refId, userId);
    try {
      const exec = await gateway.placeEquityOrder({
        accountNumber,
        symbol: stop.symbol,
        side: exitSide,
        type: routing.type,
        quantity: qty,
        limitPrice: routing.limitPrice,
        timeInForce: "gfd",
        marketHours: routing.marketHours,
        refId
      });
      // A non-throwing broker response can still be a synchronous rejection/cancellation (same
      // trap as the strategy placement paths). No order will ever execute — don't book a fill,
      // and re-arm the stop so the position isn't left unprotected behind a stuck 'triggered' row.
      if (isRejectedOrCanceledState(exec.state)) {
        revertSyntheticStopClaim(stop.id, userId);
        audit("synthetic_stop_error", { symbol: stop.symbol, error: `Broker declined the protective exit (state: ${exec.state}).`, orderId: exec.orderId }, userId, policy.connectedAccountId);
        continue;
      }
      // The fill is FINAL only when the broker confirms it filled synchronously (same rule as the
      // normal exit-placement paths in strategy.ts). Anything still resting — e.g. a market order
      // placed after hours that sits at the broker until the open — books as pending_reconciliation
      // at the provisional quote, and reconcilePendingFills finalizes the real price/qty/time from
      // the broker (brokerOrderId is the match key). Booking 'filled' at the placement-time quote
      // fabricated the realized P&L on the 2026-07-08 overnight MU exit.
      const filledNow = exec.state === "filled";
      // B8: a synchronously-filled paper/test protective exit is booked at the raw quote (no broker
      // reconciliation will follow), so debit the same execution-cost model the entry path uses —
      // otherwise the losing tail exits cost-free and overstates realized edge feeding the tuner/
      // sizer. Live sync fills prefer the broker's own average price; resting orders book the raw
      // quote provisionally and get the real fill price at reconciliation.
      const exitPrice = filledNow
        ? (source === "live" ? exec.averagePrice ?? price : applyPaperExitCost(price, exitSide, source))
        : price;
      insertFillEvent({
        userId,
        accountNumber,
        source,
        executionMode,
        symbol: normalizeSymbol(stop.symbol),
        side: exitSide,
        quantity: qty,
        price: exitPrice,
        notional: qty * exitPrice,
        status: filledNow ? "filled" : "pending_reconciliation",
        brokerOrderId: exec.orderId,
        raw: { syntheticStop: true, triggerPrice: evaln.triggerPrice }
      });
      // If a broker-held protective stop is resting for this symbol, cancel it — but ONLY when
      // this exit closes the WHOLE position (qty covers everything the broker stop didn't). A
      // PARTIAL synthetic fire (qty < positionQty) means a broker-held stop is already covering
      // the shares this exit did NOT sell (that's exactly why coverage sized this fire to the
      // uncovered remainder in the first place) — cancelling it here would strip the still-open
      // remainder of its broker-held protection for no reason, leaving it covered only by a
      // 'triggered' synthetic row that stays inert until the 15-min re-arm grace (Codex review, PR
      // #1331). Best-effort either way.
      if (qty >= positionQty - QTY_EPSILON) {
        await cancelBrokerProtectiveStop(userId, accountNumber, stop.symbol, gateway).catch(() => {});
      }
      // Already 'triggered' via the claim; this just records the final lastPrice.
      upsertSyntheticStop({ ...stop, status: "triggered", lastPrice: price });
      result.exited++;
      audit("synthetic_stop_triggered", { symbol: stop.symbol, side: stop.side, exitSide, price, triggerPrice: evaln.triggerPrice, quantity: qty, orderId: exec.orderId }, userId, policy.connectedAccountId);
    } catch (err) {
      // Placement failed/uncertain — re-arm the stop so a later tick can retry rather than
      // leaving the position unprotected behind a stuck 'triggered' row. The revert deliberately
      // KEEPS last_attempt_ref_id (and never touches fire_generation): the broker may have accepted
      // this order before the call threw, and remembering its client_order_id is what lets the
      // retry reuse the same id (422-safe) until that order is positively confirmed dead.
      revertSyntheticStopClaim(stop.id, userId);
      audit("synthetic_stop_error", { symbol: stop.symbol, error: err instanceof Error ? err.message : String(err) }, userId, policy.connectedAccountId);
    }
  }

  return result;
}
