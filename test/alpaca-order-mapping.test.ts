import { describe, expect, it } from "vitest";
import { mapAlpacaOrder, mapAlpacaOrderType } from "../src/lib/alpaca";

describe("mapAlpacaOrderType", () => {
  it("maps Alpaca raw order types to our OrderType union (no leaked raw values)", () => {
    expect(mapAlpacaOrderType("market")).toBe("market");
    expect(mapAlpacaOrderType("limit")).toBe("limit");
    expect(mapAlpacaOrderType("stop")).toBe("stop_market"); // was leaking raw "stop"
    expect(mapAlpacaOrderType("stop_limit")).toBe("stop_limit");
    expect(mapAlpacaOrderType("trailing_stop")).toBe("stop_market");
  });

  it("falls back to market for unknown/absent types instead of leaking", () => {
    expect(mapAlpacaOrderType("bracket")).toBe("market");
    expect(mapAlpacaOrderType(undefined)).toBe("market");
    expect(mapAlpacaOrderType(null)).toBe("market");
  });
});

describe("mapAlpacaOrder", () => {
  it("maps a raw Alpaca order (status→state, type mapped) into EquityOrder", () => {
    const order = mapAlpacaOrder({
      id: "o1",
      symbol: "aapl",
      side: "sell",
      type: "stop",
      status: "new",
      qty: "10",
      filled_qty: "0",
      filled_avg_price: null,
      created_at: "2026-06-25T00:00:00Z",
      client_order_id: "c1"
    });
    expect(order).toMatchObject({
      id: "o1",
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "new",
      quantity: 10,
      filledQuantity: 0,
      clientOrderId: "c1",
      placedAgent: "alpaca"
    });
    expect(order.averagePrice).toBeUndefined();
  });
});
