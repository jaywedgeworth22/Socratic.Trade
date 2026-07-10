import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  brokerProtectiveStopsEnabled,
  brokerTrailingStopsEnabled,
  cancelBrokerProtectiveStop,
  desiredBrokerStopKind,
  reconcileBrokerProtectiveStops
} from "../src/lib/broker-protective-stops";
import { getDb, listBrokerProtectiveStops } from "../src/lib/db";
import type { BrokerGateway, EquityOrder, EquityPosition, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-protstops-${randomUUID()}.db`)}`;
});

interface PlacedOrder { symbol: string; side: string; type: string; quantity?: number; stopPrice?: number; trailPercent?: number; timeInForce: string }

function fakeGateway(): BrokerGateway & { placed: PlacedOrder[]; cancelled: string[]; nextOrderId: string; placeState: string; failCancel: boolean } {
  const g = {
    placed: [] as PlacedOrder[],
    cancelled: [] as string[],
    nextOrderId: "ord-1",
    placeState: "submitted", // set to "rejected" to simulate a non-throwing synchronous broker decline
    failCancel: false, // flip to simulate a broker cancel that fails (drives the pending_cancel retry)
    async placeEquityOrder(order: any) {
      g.placed.push({ symbol: order.symbol, side: order.side, type: order.type, quantity: order.quantity, stopPrice: order.stopPrice, trailPercent: order.trailPercent, timeInForce: order.timeInForce });
      return { orderId: g.nextOrderId, refId: order.refId, state: g.placeState, raw: {} };
    },
    async cancelEquityOrder(_accountNumber: string, orderId: string) {
      if (g.failCancel) throw new Error("simulated broker cancel failure");
      g.cancelled.push(orderId);
      return { orderId, refId: "x", state: "cancel_requested", raw: {} };
    }
  };
  return g as unknown as BrokerGateway & { placed: PlacedOrder[]; cancelled: string[]; nextOrderId: string; placeState: string; failCancel: boolean };
}

function rhPolicy(account: string, over: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    activeBroker: "robinhood",
    robinhoodBrokerStops: true,
    riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8 },
    ...over
  };
}

const longPos = (symbol: string, quantity: number, averageCost: number): EquityPosition => ({
  symbol, quantity, averageCost, marketValue: quantity * averageCost
});

describe("brokerProtectiveStopsEnabled", () => {
  it("requires the flag, live RH, and a stop-loss %", () => {
    expect(brokerProtectiveStopsEnabled(rhPolicy("A"), "broker/live")).toBe(true);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A"), "broker/paper")).toBe(false);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A", { robinhoodBrokerStops: false }), "broker/live")).toBe(false);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A", { activeBroker: "alpaca" }), "broker/live")).toBe(false);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A", { riskRules: { stopLossPct: 0 } }), "broker/live")).toBe(false);
  });
});

describe("reconcileBrokerProtectiveStops", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  it("places a resting GTC stop-market SELL at stopLossPct below entry for an open long", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-1"), accountNumber: "PS-1", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(r.placed).toBe(1);
    expect(r.placedStopSymbols).toEqual(["AAPL"]); // callers use this to defer same-tick synthetic registration
    expect(gw.placed).toHaveLength(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", side: "sell", type: "stop_market", quantity: 10, stopPrice: 92, timeInForce: "gtc" });
  });

  it("is idempotent — does not double-place for a position that already has a resting stop", async () => {
    const args = { userId: "local", policy: rhPolicy("PS-2"), accountNumber: "PS-2", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true };
    await reconcileBrokerProtectiveStops(args);
    const second = await reconcileBrokerProtectiveStops(args);
    expect(second.placed).toBe(0);
    expect(gw.placed).toHaveLength(1);
  });

  it("cancels + forgets the resting stop when the position has closed", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-3"), accountNumber: "PS-3", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // Position gone → cancel.
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-3"), accountNumber: "PS-3", gateway: gw, positions: [], executionMode: "broker/live", running: true });
    expect(r.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    // A subsequent reconcile has nothing left to cancel.
    const r2 = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-3"), accountNumber: "PS-3", gateway: gw, positions: [], executionMode: "broker/live", running: true });
    expect(r2.cancelled).toBe(0);
  });

  it("cancels on close even when not running, but never places while stopped", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-4"), accountNumber: "PS-4", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    gw.placed = [];
    // Not running: a new open long does NOT get a stop placed...
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-4"), accountNumber: "PS-4", gateway: gw, positions: [], executionMode: "broker/live", running: false });
    expect(gw.placed).toHaveLength(0);
    // ...but the closed AAPL position's resting stop is still cancelled.
    expect(r.cancelled).toBe(1);
  });

  it("no-ops entirely when disabled (paper mode / flag off / wrong broker)", async () => {
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-5"), accountNumber: "PS-5", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true });
    expect(r).toEqual({ placed: 0, cancelled: 0, cancelledOrderIds: [], placedStopSymbols: [], partiallyPlacedStopSymbols: [] });
    expect(gw.placed).toHaveLength(0);
  });

  it("tears down (cancels + forgets) resting stops when the feature is DISABLED — no orphan", async () => {
    // Place a resting stop while enabled...
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-OFF"), accountNumber: "PS-OFF", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // ...now the owner turns the flag OFF while the position is STILL OPEN. Disabling gates only
    // placement, so the previously-placed broker stop must be cancelled (not stranded resting forever).
    const off = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-OFF", { robinhoodBrokerStops: false }), accountNumber: "PS-OFF",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(off.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    // The row is gone — a second disabled reconcile has nothing left to cancel (no double-cancel).
    const again = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-OFF", { robinhoodBrokerStops: false }), accountNumber: "PS-OFF",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(again.cancelled).toBe(0);
  });

  it("retries a failed cancel on disable (pending_cancel) on the next tick — never orphans", async () => {
    // Place a resting stop while enabled.
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-RETRY"), accountNumber: "PS-RETRY", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // Disable, but the broker cancel FAILS this tick → the row is kept as pending_cancel (not deleted,
    // not orphaned) so it can be retried.
    gw.failCancel = true;
    const failed = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-RETRY", { robinhoodBrokerStops: false }), accountNumber: "PS-RETRY",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(failed.cancelled).toBe(0);
    expect(gw.cancelled).toEqual([]); // nothing actually cancelled yet
    // Next tick the broker cancel succeeds → the pending_cancel row is retried and cleared.
    gw.failCancel = false;
    const retried = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-RETRY", { robinhoodBrokerStops: false }), accountNumber: "PS-RETRY",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(retried.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
  });

  it("a pending_cancel row BLOCKS re-placement — the old still-live stop is never orphaned by an upsert overwrite", async () => {
    // Place while enabled.
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-BLOCK"), accountNumber: "PS-BLOCK", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // Disable while the broker cancel FAILS → the row survives as pending_cancel, its order still
    // resting live at the broker.
    gw.failCancel = true;
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-BLOCK", { robinhoodBrokerStops: false }), accountNumber: "PS-BLOCK",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    // Re-enable with the cancel STILL failing. Placement must be BLOCKED: placing would upsert a
    // new broker_order_id over the pending_cancel row (UNIQUE user/account/symbol), leaving the old
    // still-live full-size GTC stop resting at the broker with no tracking and no cancel retry.
    gw.nextOrderId = "ord-2";
    const reEnabled = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-BLOCK"), accountNumber: "PS-BLOCK", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(reEnabled.placed).toBe(0);
    expect(gw.placed).toHaveLength(1); // no second placement while the first stop's fate is unresolved
    let rows = listBrokerProtectiveStops("PS-BLOCK", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-1", status: "pending_cancel" }); // original id preserved
    // Once the cancel finally lands, the retry pass clears the row and placement resumes next pass.
    gw.failCancel = false;
    const recovered = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-BLOCK"), accountNumber: "PS-BLOCK", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(recovered.cancelledOrderIds).toEqual(["ord-1"]);
    expect(recovered.placed).toBe(1);
    expect(gw.placed).toHaveLength(2);
    rows = listBrokerProtectiveStops("PS-BLOCK", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-2", status: "resting" });
  });

  it("recovers a stuck pending_cancel row once the caller's order list shows it done resting — re-placement resumes the same tick", async () => {
    // Place a resting stop while enabled.
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-DEAD"), accountNumber: "PS-DEAD", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // A quantity mismatch triggers cancel-then-replace, but the cancel FAILS every tick (e.g.
    // "order not found" after an earlier cancel attempt actually landed broker-side) — the row is
    // stuck as pending_cancel.
    gw.failCancel = true;
    const stuck = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-DEAD"), accountNumber: "PS-DEAD", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true });
    expect(stuck.cancelled).toBe(0);
    let rows = listBrokerProtectiveStops("PS-DEAD", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-1", status: "pending_cancel" });
    // Without evidence the order is dead, a bare retry (no `orders` passed) keeps it stuck AND
    // keeps blocking re-placement for the now-mismatched position.
    const stillStuck = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-DEAD"), accountNumber: "PS-DEAD", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true });
    expect(stillStuck.cancelled).toBe(0);
    expect(stillStuck.placed).toBe(0);
    expect(listBrokerProtectiveStops("PS-DEAD", "local")).toHaveLength(1);
    expect(gw.placed).toHaveLength(1); // still no second (orphaning) placement
    // Now the caller (the synthetic-stop monitor) passes its freshly fetched order list, and
    // ord-1 shows up there already terminal ("canceled") — the earlier cancel actually landed,
    // the broker's "not found" response was just stale. Section 1 clears the row from that
    // evidence (the cancel call itself still throws), which unblocks section 4 in the SAME
    // reconcile pass — re-placement resumes immediately, not on some later tick.
    gw.nextOrderId = "ord-2";
    const orders: EquityOrder[] = [{ id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "canceled", createdAt: new Date().toISOString() }];
    const recovered = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-DEAD"), accountNumber: "PS-DEAD", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true, orders });
    expect(recovered.cancelled).toBe(0); // recovered via the order list, not an actual successful cancel
    expect(recovered.placed).toBe(1); // section 4 immediately re-places once the block clears
    rows = listBrokerProtectiveStops("PS-DEAD", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-2", status: "resting", quantity: 12 });
  });

  it("also recovers when the caller's order list shows the stop already FILLED (cancel-of-a-fill always fails), but DEFERS re-placement to the next call — a fill actually moves the position, and `positions` was fetched by the caller before `orders`, so this call's `positions` may still be the stale pre-fill snapshot", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    gw.failCancel = true;
    // Position closed (the stop itself filled and sold the shares) → section-2 cancel-on-close
    // attempts to cancel a now-filled order, which always fails, landing it as pending_cancel.
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [], executionMode: "broker/live", running: true });
    expect(listBrokerProtectiveStops("PS-FILLED", "local")).toHaveLength(1);
    expect(gw.cancelled).toEqual([]); // the cancel call never actually succeeded
    // AAPL is re-bought later in the session — a fresh stop is needed, but the dead row still
    // blocks section 4 without evidence.
    const blocked = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [longPos("AAPL", 5, 110)], executionMode: "broker/live", running: true });
    expect(blocked.placed).toBe(0);
    // The caller's order list shows ord-1 already FILLED (a filled order can never be cancelled —
    // it's just as terminal as a rejection for this purpose). Section 1 clears the row THIS call,
    // but section 4 must NOT re-place in the same call: the `positions` array this call was handed
    // (still [longPos("AAPL", 5, 110)], simulating the caller's pre-orders-fetch snapshot) cannot be
    // trusted to already reflect a fill that section 1 only just learned about from `orders`.
    gw.nextOrderId = "ord-3";
    const orders: EquityOrder[] = [{ id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "filled", createdAt: new Date().toISOString() }];
    const recovered = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [longPos("AAPL", 5, 110)], executionMode: "broker/live", running: true, orders });
    expect(recovered.placed).toBe(0); // deferred — no same-call replacement off a possibly-stale snapshot
    expect(listBrokerProtectiveStops("PS-FILLED", "local")).toHaveLength(0); // row gone, nothing resting yet
    expect(gw.placed).toHaveLength(1); // still just the original placement — no premature second one
    // The NEXT call brings a fresh position read (no filled-order evidence needed this time — the
    // row is already gone): placement resumes normally, sized off the current quantity.
    const resumed = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [longPos("AAPL", 5, 110)], executionMode: "broker/live", running: true });
    expect(resumed.placed).toBe(1);
    const rows = listBrokerProtectiveStops("PS-FILLED", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-3", status: "resting", quantity: 5 });
  });

  it("stays conservative — never deletes a pending_cancel row when the order is ABSENT from the caller's list or still LIVE", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-LIVE"), accountNumber: "PS-LIVE", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    gw.failCancel = true;
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-LIVE"), accountNumber: "PS-LIVE", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true });
    expect(listBrokerProtectiveStops("PS-LIVE", "local")).toHaveLength(1);
    // Order list fetched but doesn't contain ord-1 at all (e.g. broker excludes very old orders
    // from the default query window) — absence is NOT positive evidence of death.
    const r1 = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-LIVE"), accountNumber: "PS-LIVE", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true, orders: [] });
    expect(r1.cancelled).toBe(0);
    expect(listBrokerProtectiveStops("PS-LIVE", "local")).toHaveLength(1);
    // Order list contains ord-1 but it's still LIVE (e.g. "confirmed") — the cancel request may
    // simply not have been processed by the broker yet. Must not delete a row for a still-live
    // order — that would orphan it (two resting sell stops, one untracked, once section 4 places
    // a replacement).
    const liveOrders: EquityOrder[] = [{ id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "confirmed", createdAt: new Date().toISOString() }];
    const r2 = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-LIVE"), accountNumber: "PS-LIVE", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true, orders: liveOrders });
    expect(r2.cancelled).toBe(0);
    const rows = listBrokerProtectiveStops("PS-LIVE", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-1", status: "pending_cancel" });
    expect(gw.placed).toHaveLength(1); // still no second (orphaning) placement
  });

  it("ignores a synchronously REJECTED placement — no row, no placed count, symbol not advertised", async () => {
    // placeEquityOrder can resolve (not throw) with a terminal state AND an order id. Recording that
    // as a 'resting' row would (1) advertise the symbol via placedStopSymbols and suppress this
    // tick's synthetic registration for protection that doesn't exist, and (2) leave a zombie row
    // that blocks section-4 re-placement on every later tick (section 3 sees no qty/price mismatch
    // on a dead order, so nothing ever clears it until the position closes).
    gw.placeState = "rejected";
    const args = { userId: "local", policy: rhPolicy("PS-REJ"), accountNumber: "PS-REJ", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true };
    const r = await reconcileBrokerProtectiveStops(args);
    expect(gw.placed).toHaveLength(1); // the placement WAS attempted…
    expect(r.placed).toBe(0); // …but a declined stop is not a placed stop
    expect(r.placedStopSymbols).toEqual([]); // synthetic registration must not be suppressed
    expect(listBrokerProtectiveStops("PS-REJ", "local")).toHaveLength(0); // no zombie 'resting' row
    const receipts = (getDb().prepare("SELECT payload FROM audit_events WHERE kind = 'broker_protective_stop_error'").all() as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
      .filter((p) => p.symbol === "AAPL" && String(p.error).includes("declined the protective stop (state: rejected)"));
    expect(receipts).toHaveLength(1);
    // Recovery: nothing blocks the retry — the next tick's reconcile simply places again.
    gw.placeState = "submitted";
    const r2 = await reconcileBrokerProtectiveStops(args);
    expect(r2.placed).toBe(1);
    expect(r2.placedStopSymbols).toEqual(["AAPL"]);
    expect(listBrokerProtectiveStops("PS-REJ", "local")).toHaveLength(1);
  });

  it("cancelBrokerProtectiveStop removes a symbol's resting stop on demand", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-6"), accountNumber: "PS-6", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    await cancelBrokerProtectiveStop("local", "PS-6", "AAPL", gw);
    expect(gw.cancelled).toEqual(["ord-1"]);
    // It's forgotten — a reconcile with the still-open position re-places a fresh one.
    gw.nextOrderId = "ord-2";
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-6"), accountNumber: "PS-6", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(r.placed).toBe(1);
  });
});

// ── Broker-held TRAILING stops ────────────────────────────────────────────────

function alpacaTrailPolicy(account: string, over: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    activeBroker: "alpaca",
    riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 },
    ...over
  };
}

function rhTrailPolicy(account: string, over: Partial<TradingPolicy> = {}): TradingPolicy {
  return rhPolicy(account, {
    riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8, trailingStopPct: 5 },
    ...over
  });
}

/** A position whose current mark can differ from entry (marketValue = qty × mark). */
const markedPos = (symbol: string, quantity: number, averageCost: number, mark: number): EquityPosition => ({
  symbol, quantity, averageCost, marketValue: quantity * mark
});

const liveSellOrder = (symbol: string, quantity: number): EquityOrder => ({
  id: `cov-${symbol}`, symbol, side: "sell", type: "stop_market", state: "new",
  quantity, timeInForce: "gtc", createdAt: new Date().toISOString(), placedAgent: "alpaca"
});

describe("brokerTrailingStopsEnabled / desiredBrokerStopKind", () => {
  it("requires a trailing %, honors the off-switch, and knows each broker's lane", () => {
    // Alpaca: native trailing in both environments.
    expect(brokerTrailingStopsEnabled(alpacaTrailPolicy("A"), "broker/paper")).toBe(true);
    expect(brokerTrailingStopsEnabled(alpacaTrailPolicy("A"), "broker/live")).toBe(true);
    // No trailing % configured → inert (the DEFAULT_POLICY case).
    expect(brokerTrailingStopsEnabled(alpacaTrailPolicy("A", { riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 0 } }), "broker/paper")).toBe(false);
    // The owner's off-switch.
    expect(brokerTrailingStopsEnabled(alpacaTrailPolicy("A", { brokerTrailingStops: false }), "broker/paper")).toBe(false);
    // Robinhood: live only, and only under the robinhoodBrokerStops opt-in.
    expect(brokerTrailingStopsEnabled(rhTrailPolicy("A"), "broker/live")).toBe(true);
    expect(brokerTrailingStopsEnabled(rhTrailPolicy("A"), "broker/paper")).toBe(false);
    expect(brokerTrailingStopsEnabled(rhTrailPolicy("A", { robinhoodBrokerStops: false }), "broker/live")).toBe(false);
  });

  it("trailing takes precedence over the RH fixed lane; neither → null", () => {
    expect(desiredBrokerStopKind(rhTrailPolicy("A"), "broker/live")).toBe("trailing");
    expect(desiredBrokerStopKind(rhPolicy("A"), "broker/live")).toBe("fixed");
    expect(desiredBrokerStopKind(rhPolicy("A", { robinhoodBrokerStops: false }), "broker/live")).toBe(null);
    expect(desiredBrokerStopKind(DEFAULT_POLICY, "broker/paper")).toBe(null);
  });
});

describe("reconcileBrokerProtectiveStops — trailing lane", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  it("places a NATIVE trailing stop on Alpaca (trailPercent, no stopPrice) and records a trailing row", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-1"), accountNumber: "TR-1", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 10, trailPercent: 5, timeInForce: "gtc" });
    expect(gw.placed[0].stopPrice).toBeUndefined(); // the broker computes/moves the trigger itself
    const rows = listBrokerProtectiveStops("TR-1", "local");
    expect(rows[0]).toMatchObject({ kind: "trailing", trailPercent: 5, quantity: 10 });
  });

  it("floors Alpaca native trailing stops to whole shares and skips sub-share positions", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-2"), accountNumber: "TR-2", gateway: gw,
      positions: [longPos("MSFT", 10.6, 100), longPos("NVDA", 0.4, 500)], executionMode: "broker/paper", running: true
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "MSFT", quantity: 10 }); // 10.6 → 10; the synthetic monitor covers the 0.6
    // A floored (partial) placement must NOT suppress synthetic REGISTRATION — the 0.6-share
    // remainder still needs app-side protection this tick. It is advertised separately so the
    // caller only defers the FIRE path. NVDA (0.4 sh) is left entirely to the synthetic monitor.
    expect(r.placedStopSymbols).toEqual([]);
    expect(r.partiallyPlacedStopSymbols).toEqual(["MSFT"]);
  });

  it("does NOT reprice a native Alpaca trailing stop as the mark moves (the broker trails it)", async () => {
    const args = (mark: number) => ({
      userId: "local", policy: alpacaTrailPolicy("TR-3"), accountNumber: "TR-3", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, mark)], executionMode: "broker/paper" as const, running: true
    });
    await reconcileBrokerProtectiveStops(args(100));
    const r = await reconcileBrokerProtectiveStops(args(140)); // big rally — still no cancel-replace
    expect(r.cancelled).toBe(0);
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(1);
  });

  it("places a RATCHETED stop-market on live Robinhood at trail% below max(mark, entry)", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("TR-4"), accountNumber: "TR-4", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 120)], executionMode: "broker/live", running: true
    });
    expect(r.placed).toBe(1);
    // 5% below the 120 mark (the observable high-water), NOT 8% below the 100 entry.
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", side: "sell", type: "stop_market", quantity: 10, stopPrice: 114, timeInForce: "gtc" });
    expect(gw.placed[0].trailPercent).toBeUndefined(); // RH MCP has no verified native trailing param
    expect(listBrokerProtectiveStops("TR-4", "local")[0]).toMatchObject({ kind: "trailing", trailPercent: 5, stopPrice: 114 });
  });

  it("ratchets the Robinhood trailing stop UP as the mark rises, and never back down", async () => {
    const args = (mark: number) => ({
      userId: "local", policy: rhTrailPolicy("TR-5"), accountNumber: "TR-5", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, mark)], executionMode: "broker/live" as const, running: true
    });
    await reconcileBrokerProtectiveStops(args(100)); // initial: trigger 95
    expect(listBrokerProtectiveStops("TR-5", "local")[0].stopPrice).toBe(95);
    // Mark rises to 120 → cancel-replace at 114.
    gw.nextOrderId = "ord-2";
    const up = await reconcileBrokerProtectiveStops(args(120));
    expect(up.cancelled).toBe(1);
    expect(up.placed).toBe(1);
    expect(listBrokerProtectiveStops("TR-5", "local")[0]).toMatchObject({ brokerOrderId: "ord-2", stopPrice: 114 });
    // Mark falls back to 105 → the 114 trigger HOLDS (ratchet, not a re-anchor).
    const down = await reconcileBrokerProtectiveStops(args(105));
    expect(down.cancelled).toBe(0);
    expect(down.placed).toBe(0);
    expect(listBrokerProtectiveStops("TR-5", "local")[0].stopPrice).toBe(114);
  });

  it("replaces a FIXED row with a TRAILING one when the trailing lane turns on (kind mismatch)", async () => {
    // Fixed stop first (trailing % not yet configured).
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("TR-6"), accountNumber: "TR-6", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(listBrokerProtectiveStops("TR-6", "local")[0]).toMatchObject({ kind: "fixed", stopPrice: 92 });
    // Owner sets a trailing % → same tick: cancel the fixed stop, place the trailing one.
    gw.nextOrderId = "ord-2";
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhTrailPolicy("TR-6"), accountNumber: "TR-6", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(r.cancelled).toBe(1);
    expect(r.placed).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(listBrokerProtectiveStops("TR-6", "local")[0]).toMatchObject({ kind: "trailing", brokerOrderId: "ord-2", stopPrice: 95 });
  });

  it("skips placement when another live exit order already covers the position (bracket leg / manual sell)", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-7"), accountNumber: "TR-7", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
      orders: [liveSellOrder("AAPL", 10)]
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    // A PARTIAL cover: the broker stop is sized to the UNCOVERED remainder only (never stacking
    // more exit quantity than the account holds), and advertised as a partial placement.
    const partial = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-7"), accountNumber: "TR-7", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
      orders: [liveSellOrder("AAPL", 3)]
    });
    expect(partial.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", quantity: 7 });
    expect(partial.placedStopSymbols).toEqual([]);
    expect(partial.partiallyPlacedStopSymbols).toEqual(["AAPL"]);
  });

  it("does NOT arm a broker trail that is already breached — the synthetic monitor owns the exit", async () => {
    // avg 100, mark 90, trail 5% → entry-seeded trigger 95 is already breached. A native trailing
    // order would restart the trail from 90 (deferring the exit by another 5%), and a ratcheted
    // stop would rest with its trigger above the market — so placement is skipped and the symbol
    // is NOT advertised, letting the synthetic monitor register and fire the app-defined exit.
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-9"), accountNumber: "TR-9", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 90)], executionMode: "broker/paper", running: true
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    expect(r.placedStopSymbols).toEqual([]);
    expect(r.partiallyPlacedStopSymbols).toEqual([]);
  });

  it("does NOT arm a NATIVE trail while the mark sits below entry (looser-than-app trigger), but the ratcheted lane still rests at the entry-seeded trigger", async () => {
    // avg 100, mark 96, trail 5%: the app's entry-seeded trigger is 95 (not yet breached), but a
    // native Alpaca trail would seed from 96 → trigger ~91.2, LOOSER than the app's. Skip native
    // placement (synthetic keeps the 95 trail) until the mark recovers to entry.
    const native = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-11"), accountNumber: "TR-11", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 96)], executionMode: "broker/paper", running: true
    });
    expect(native.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    // The ratcheted lane (live Robinhood) has no such looseness — its explicit trigger IS the
    // entry-seeded 95, still below the 96 mark, so it rests normally.
    const ratcheted = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("TR-12"), accountNumber: "TR-12", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 96)], executionMode: "broker/live", running: true
    });
    expect(ratcheted.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", type: "stop_market", stopPrice: 95 });
  });

  it("alpaca-mcp accounts take the RATCHETED lane (stop_market via their MCP transport), not REST-native trailing", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-10", { activeBroker: "alpaca-mcp" }), accountNumber: "TR-10", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 120)], executionMode: "broker/paper", running: true
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", type: "stop_market", quantity: 10, stopPrice: 114 });
    expect(gw.placed[0].trailPercent).toBeUndefined(); // never sends the REST-only native param
  });

  it("tears trailing stops down when the owner opts out (brokerTrailingStops: false, no trailing %→fixed either)", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: alpacaTrailPolicy("TR-8"), accountNumber: "TR-8", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true });
    expect(gw.placed).toHaveLength(1);
    const off = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-8", { brokerTrailingStops: false }), accountNumber: "TR-8",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true
    });
    expect(off.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(listBrokerProtectiveStops("TR-8", "local")).toHaveLength(0);
  });

  describe("ordersListed: false — a failed order-list fetch must never be mistaken for confirmed-empty coverage", () => {
    it("skips NEW placement entirely (never assumes coverage-free) when the caller's fetch failed", async () => {
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-13"), accountNumber: "TR-13", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
        orders: [], ordersListed: false
      });
      expect(r.placed).toBe(0);
      expect(gw.placed).toHaveLength(0);
      expect(r.placedStopSymbols).toEqual([]);
      expect(r.partiallyPlacedStopSymbols).toEqual([]);
      // Recovery: the NEXT tick's successful fetch (even an honestly-empty one) places normally.
      const recovered = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-13"), accountNumber: "TR-13", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
        orders: [], ordersListed: true
      });
      expect(recovered.placed).toBe(1);
    });

    it("leaves an EXISTING resting stop untouched (no spurious mismatch-cancel) when the caller's fetch failed", async () => {
      // Place normally first (a genuinely successful, empty fetch).
      await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-14"), accountNumber: "TR-14", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
        orders: [], ordersListed: true
      });
      expect(gw.placed).toHaveLength(1);
      // Next tick: the fetch THROWS (caller passes ordersListed: false). Without the fix, an
      // unknown-coverage read collapses to "fully uncovered", the existing 10-sh stop looks
      // undersized against a phantom "other order" story, and section 3 cancels it — then section 4
      // ALSO can't verify coverage and skips replacing it, leaving the position with NO broker-held
      // stop at all this tick.
      const failed = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-14"), accountNumber: "TR-14", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
        orders: [], ordersListed: false
      });
      expect(failed.cancelled).toBe(0);
      expect(gw.cancelled).toEqual([]);
      const stops = listBrokerProtectiveStops("TR-14", "local");
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ brokerOrderId: "ord-1", status: "resting", quantity: 10 });
    });

    it("omitting ordersListed (default true) preserves the original protection-over-dedup behavior", async () => {
      // No `orders` param at all, matching every pre-existing caller/test — must place at full size
      // exactly as before this fix (ordersListed defaults to true, so an empty `orders` still reads
      // as "confirmed no coverage", never as "unknown").
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: rhPolicy("TR-15"), accountNumber: "TR-15", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
      });
      expect(r.placed).toBe(1);
      expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", quantity: 10 });
    });
  });

  describe("extremePriceBySymbol — never arm a broker trail looser than the app's own already-tracked high-water mark", () => {
    it("uses the synthetic monitor's tracked extreme (not just current mark) to seed the ratcheted trigger", async () => {
      // avg 100, synthetic-tracked extreme 130, mark 125 (pulled back from the peak but still above
      // the real trigger — not yet breached), trail 5%: the app's real trigger is 130*0.95=123.50.
      // Recomputing from max(mark=125, entry=100) alone would produce 118.75 — looser.
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: rhTrailPolicy("TR-16"), accountNumber: "TR-16", gateway: gw,
        positions: [markedPos("AAPL", 10, 100, 125)], executionMode: "broker/live", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(r.placed).toBe(1);
      expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", stopPrice: 123.5 });
    });

    it("refuses a NATIVE trail while the mark sits below the tracked extreme, even if mark is above entry", async () => {
      // avg 100, tracked extreme 130, mark 120 (above entry, but a pullback from the real high). A
      // native Alpaca trail seeded from the current 120 mark would trail from 120, not 130 — looser
      // than the app's own trail. Must be refused; the synthetic monitor keeps covering.
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-17"), accountNumber: "TR-17", gateway: gw,
        positions: [markedPos("AAPL", 10, 100, 120)], executionMode: "broker/paper", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(r.placed).toBe(0);
      expect(gw.placed).toHaveLength(0);
    });

    it("places a native trail once the mark recovers to at/above the tracked extreme", async () => {
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-17b"), accountNumber: "TR-17b", gateway: gw,
        positions: [markedPos("AAPL", 10, 100, 130)], executionMode: "broker/paper", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(r.placed).toBe(1);
    });

    it("does NOT cancel an existing mismatched trail if the replacement would be refused (mark below the tracked extreme) — keeps the old stop rather than stranding the position", async () => {
      // Seed a resting trailing stop at the CORRECT (tracked-extreme-based) trigger 123.5 for a 10%
      // trail config that's about to change to 5% (forcing a "trail %" mismatch)... simpler: seed a
      // resting stop with a stale trail% so section 3 detects a mismatch, while the mark has pulled
      // back below the tracked extreme so a replacement would be refused.
      const gw2 = fakeGateway();
      const policy = rhTrailPolicy("TR-18");
      // Establish the resting stop while mark == tracked extreme (recovers, places fine).
      await reconcileBrokerProtectiveStops({
        userId: "local", policy, accountNumber: "TR-18", gateway: gw2,
        positions: [markedPos("AAPL", 10, 100, 130)], executionMode: "broker/live", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(gw2.placed).toHaveLength(1);
      expect(gw2.placed[0].stopPrice).toBeCloseTo(123.5);
      // Now the trail % changes (10% instead of 5%) — a genuine mismatch — but the mark has since
      // pulled back to 115, below the tracked extreme of 130. A replacement seeded from 130 at 10%
      // would be FINE (130*0.9=117, still below tracked extreme check just cares about mark vs
      // extreme for NATIVE; this is the ratcheted RH lane, whose guard is "already breached", i.e.
      // stopPrice >= mark). New trigger at 10% off 130 = 117, mark = 115 -> 117 >= 115: breached,
      // so the replacement WOULD be refused. The old (123.5) stop must be kept, not cancelled.
      const changedPolicy = rhTrailPolicy("TR-18", { riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8, trailingStopPct: 10 } });
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: changedPolicy, accountNumber: "TR-18", gateway: gw2,
        positions: [markedPos("AAPL", 10, 100, 115)], executionMode: "broker/live", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(r.cancelled).toBe(0);
      expect(gw2.cancelled).toEqual([]);
      const stops = listBrokerProtectiveStops("TR-18", "local");
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ stopPrice: 123.5, trailPercent: 5 }); // unchanged — old stop kept
    });
  });
});
