import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { toBrokerSide, isShortIntent, isRejectedOrCanceledState, isLiveOrderState, liveExitOrderCoverage } from "../src/lib/broker-side";
import { ACTIVE_BROKER_ORDER_STATES } from "../src/lib/broker-held-orders";
import { toMcpOrder } from "../src/lib/robinhood";
import type { EquityOrder, EquityOrderInput, OrderSide } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-broker-side-${randomUUID()}.db`)}`;
});

const order = (side: OrderSide): EquityOrderInput => ({
  accountNumber: "ACCT-1",
  symbol: "AAPL",
  side,
  type: "market",
  quantity: 1,
  timeInForce: "gfd",
  marketHours: "regular_hours"
});

describe("toBrokerSide — intent side → broker buy/sell", () => {
  it("maps buy→buy, sell→sell, short→sell, cover→buy", () => {
    expect(toBrokerSide("buy")).toBe("buy");
    expect(toBrokerSide("sell")).toBe("sell");
    expect(toBrokerSide("short")).toBe("sell"); // open a short by selling
    expect(toBrokerSide("cover")).toBe("buy"); // close a short by buying
  });

  it("isShortIntent flags only short/cover", () => {
    expect(isShortIntent("short")).toBe(true);
    expect(isShortIntent("cover")).toBe(true);
    expect(isShortIntent("buy")).toBe(false);
    expect(isShortIntent("sell")).toBe(false);
  });
});

describe("isRejectedOrCanceledState — broker-agnostic terminal-decline check", () => {
  it("recognizes both spellings of canceled and other terminal-decline states", () => {
    expect(isRejectedOrCanceledState("rejected")).toBe(true);
    expect(isRejectedOrCanceledState("canceled")).toBe(true);
    expect(isRejectedOrCanceledState("cancelled")).toBe(true);
    expect(isRejectedOrCanceledState("failed")).toBe(true);
    expect(isRejectedOrCanceledState("expired")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isRejectedOrCanceledState("REJECTED")).toBe(true);
    expect(isRejectedOrCanceledState("Cancelled")).toBe(true);
  });

  it("does not flag accepted/filled/unknown states", () => {
    expect(isRejectedOrCanceledState("filled")).toBe(false);
    expect(isRejectedOrCanceledState("partially_filled")).toBe(false);
    expect(isRejectedOrCanceledState("accepted")).toBe(false);
    expect(isRejectedOrCanceledState("new")).toBe(false);
    expect(isRejectedOrCanceledState("submitted")).toBe(false);
    expect(isRejectedOrCanceledState(undefined)).toBe(false);
    expect(isRejectedOrCanceledState(null)).toBe(false);
  });
});

describe("isLiveOrderState — broker-agnostic resting/live check", () => {
  it("recognizes Alpaca-flavored resting/working states", () => {
    expect(isLiveOrderState("new")).toBe(true);
    expect(isLiveOrderState("accepted")).toBe(true);
    expect(isLiveOrderState("pending_new")).toBe(true);
    expect(isLiveOrderState("held")).toBe(true);
    expect(isLiveOrderState("partially_filled")).toBe(true);
    expect(isLiveOrderState("open")).toBe(true);
  });

  it("recognizes Robinhood resting states (queued/confirmed/unconfirmed) — the double-exit fix", () => {
    // A resting RH broker stop reports one of these; before the fix they were unrecognized, so the
    // synthetic monitor couldn't see the broker stop and could fire its own market sell on top of it.
    expect(isLiveOrderState("queued")).toBe(true);
    expect(isLiveOrderState("confirmed")).toBe(true);
    expect(isLiveOrderState("unconfirmed")).toBe(true);
  });

  it("recognizes non-terminal in-transition states — a pending_cancel exit can still fill", () => {
    // These are known-active in broker-held-orders.ts but were missing here, so an exit order
    // mid-cancel/replace stopped counting as coverage and a duplicate protective exit could stack
    // on top of an order that could still execute.
    expect(isLiveOrderState("submitted")).toBe(true);
    expect(isLiveOrderState("pending_cancel")).toBe(true);
    expect(isLiveOrderState("pending_replace")).toBe(true);
    expect(isLiveOrderState("suspended")).toBe(true);
  });

  it("is a superset of broker-held-orders' active vocabulary — the two sets must not drift", () => {
    for (const state of ACTIVE_BROKER_ORDER_STATES) {
      expect(isLiveOrderState(state), `broker-held-orders counts "${state}" as active — it must be live here too`).toBe(true);
    }
  });

  it("is case-insensitive and trims", () => {
    expect(isLiveOrderState("CONFIRMED")).toBe(true);
    expect(isLiveOrderState("  Queued  ")).toBe(true);
  });

  it("does not flag terminal or unknown states (bias: when unsure, treat as NOT live)", () => {
    expect(isLiveOrderState("filled")).toBe(false);
    expect(isLiveOrderState("canceled")).toBe(false);
    expect(isLiveOrderState("cancelled")).toBe(false);
    expect(isLiveOrderState("rejected")).toBe(false);
    expect(isLiveOrderState("expired")).toBe(false);
    expect(isLiveOrderState("failed")).toBe(false);
    expect(isLiveOrderState("something_else")).toBe(false);
    expect(isLiveOrderState(undefined)).toBe(false);
    expect(isLiveOrderState(null)).toBe(false);
  });

  it("is complementary to isRejectedOrCanceledState — no state is both live and terminal-decline", () => {
    for (const s of ["new", "accepted", "queued", "confirmed", "unconfirmed", "held", "open", "partially_filled"]) {
      expect(isLiveOrderState(s)).toBe(true);
      expect(isRejectedOrCanceledState(s)).toBe(false);
    }
  });
});

describe("Robinhood toMcpOrder — fail closed on short/cover", () => {
  it("throws for short and cover (Robinhood has no equity shorting), never emitting an invalid side", () => {
    expect(() => toMcpOrder(order("short"))).toThrow(/short/i);
    expect(() => toMcpOrder(order("cover"))).toThrow(/short/i);
  });

  it("passes buy/sell through with a broker-valid side", () => {
    expect(toMcpOrder(order("buy")).side).toBe("buy");
    expect(toMcpOrder(order("sell")).side).toBe("sell");
  });

  it("throws on trailPercent — the RH MCP has no verified native trailing param; the reconciler ratchets instead", () => {
    expect(() => toMcpOrder({ ...order("sell"), trailPercent: 5 })).toThrow(/trailing/i);
  });
});

// The Alpaca SDK is mocked so we can capture exactly what side reaches createOrder. With no active
// connected account the gateway uses the REST path (isMcp=false) and calls this.alpaca.createOrder.
const createOrder = vi.fn(async (opts: Record<string, unknown>) => ({
  id: "ord-1",
  status: "accepted",
  filled_qty: "0",
  filled_avg_price: null,
  ...opts
}));
vi.mock("@alpacahq/alpaca-trade-api", () => ({
  default: vi.fn(function () {
    return { createOrder, getAccount: vi.fn(), getPositions: vi.fn() };
  })
}));

describe("Alpaca placeEquityOrder — translates short/cover before the network call", () => {
  it("submits short as a broker 'sell' and cover as a broker 'buy'", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    createOrder.mockClear();
    await gateway.placeEquityOrder({ ...order("short"), refId: "r1" });
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder.mock.calls[0][0].side).toBe("sell");

    createOrder.mockClear();
    await gateway.placeEquityOrder({ ...order("cover"), refId: "r2" });
    expect(createOrder.mock.calls[0][0].side).toBe("buy");

    createOrder.mockClear();
    await gateway.placeEquityOrder({ ...order("buy"), refId: "r3" });
    expect(createOrder.mock.calls[0][0].side).toBe("buy");
  });
});

describe("liveExitOrderCoverage — OCO bracket legs must not double-count", () => {
  const sellOrder = (id: string, type: EquityOrder["type"], quantity: number): EquityOrder => ({
    id, symbol: "AAPL", side: "sell", type, state: "new", quantity, timeInForce: "gtc",
    createdAt: new Date().toISOString(), placedAgent: "alpaca"
  });

  it("counts a matched stop+limit OCO pair ONCE, not summed (a full 100-sh bracket covers 100, not 200)", () => {
    const orders = [sellOrder("stop-1", "stop_market", 100), sellOrder("tp-1", "limit", 100)];
    const cov = liveExitOrderCoverage(orders, "AAPL", "long");
    expect(cov.coveredQty).toBe(100);
    expect(cov.unknownQty).toBe(false);
  });

  it("counts TWO independent OCO pairs correctly (100 total from a 50+50 scale-in, not 200)", () => {
    const orders = [
      sellOrder("stop-1", "stop_market", 50), sellOrder("tp-1", "limit", 50),
      sellOrder("stop-2", "stop_market", 50), sellOrder("tp-2", "limit", 50)
    ];
    const cov = liveExitOrderCoverage(orders, "AAPL", "long");
    expect(cov.coveredQty).toBe(100);
  });

  it("a HALF-bracketed position (one OCO pair for 50 of 100 real shares) reports 50 covered, not 100 — the other 50 are genuinely naked", () => {
    const orders = [sellOrder("stop-1", "stop_market", 50), sellOrder("tp-1", "limit", 50)];
    const cov = liveExitOrderCoverage(orders, "AAPL", "long");
    expect(cov.coveredQty).toBe(50); // NOT 100 — summing the two legs would hide the uncovered half
  });

  it("an UNPAIRED lone resting stop (no matching limit leg) still counts on its own", () => {
    const orders = [sellOrder("stop-1", "stop_market", 30)];
    const cov = liveExitOrderCoverage(orders, "AAPL", "long");
    expect(cov.coveredQty).toBe(30);
  });

  it("an UNPAIRED lone take-profit limit (no bracket, manual take-profit-only sell) still counts on its own", () => {
    const orders = [sellOrder("tp-1", "limit", 20)];
    const cov = liveExitOrderCoverage(orders, "AAPL", "long");
    expect(cov.coveredQty).toBe(20);
  });

  it("does not pair legs of DIFFERENT quantities — each counts independently", () => {
    // A 40-share stop and a 25-share limit sell are not siblings of the same bracket (mismatched
    // quantity), so both count on their own: 40 + 25 = 65.
    const orders = [sellOrder("stop-1", "stop_market", 40), sellOrder("tp-1", "limit", 25)];
    const cov = liveExitOrderCoverage(orders, "AAPL", "long");
    expect(cov.coveredQty).toBe(65);
  });

  it("a stop-limit type leg pairs the same as a plain stop-market", () => {
    const orders = [sellOrder("stop-1", "stop_limit", 75), sellOrder("tp-1", "limit", 75)];
    const cov = liveExitOrderCoverage(orders, "AAPL", "long");
    expect(cov.coveredQty).toBe(75);
  });
});
