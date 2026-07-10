import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  brokerProtectiveStopsEnabled,
  cancelBrokerProtectiveStop,
  reconcileBrokerProtectiveStops
} from "../src/lib/broker-protective-stops";
import { getDb, listBrokerProtectiveStops } from "../src/lib/db";
import type { BrokerGateway, EquityPosition, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-protstops-${randomUUID()}.db`)}`;
});

interface PlacedOrder { symbol: string; side: string; type: string; quantity?: number; stopPrice?: number; timeInForce: string }

function fakeGateway(): BrokerGateway & { placed: PlacedOrder[]; cancelled: string[]; nextOrderId: string; placeState: string; failCancel: boolean } {
  const g = {
    placed: [] as PlacedOrder[],
    cancelled: [] as string[],
    nextOrderId: "ord-1",
    placeState: "submitted", // set to "rejected" to simulate a non-throwing synchronous broker decline
    failCancel: false, // flip to simulate a broker cancel that fails (drives the pending_cancel retry)
    async placeEquityOrder(order: any) {
      g.placed.push({ symbol: order.symbol, side: order.side, type: order.type, quantity: order.quantity, stopPrice: order.stopPrice, timeInForce: order.timeInForce });
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
    expect(r).toEqual({ placed: 0, cancelled: 0, cancelledOrderIds: [], placedStopSymbols: [] });
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
