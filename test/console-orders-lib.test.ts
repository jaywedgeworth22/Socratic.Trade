import { describe, expect, it } from "vitest";

import { closingOrderPnl, effectiveOrderPrice, matchPosition } from "../app/console/orders/lib";
import type { EquityOrder, EquityPosition } from "../src/lib/types";

function order(overrides: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "o1",
    symbol: "AAPL",
    side: "sell",
    type: "limit",
    state: "new",
    quantity: 10,
    filledQuantity: 0,
    createdAt: "2026-07-15T14:00:00.000Z",
    ...overrides
  };
}

describe("matchPosition — held position for an order's symbol, normalized", () => {
  const positions: EquityPosition[] = [
    { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_200 },
    { symbol: "TSLA", quantity: -5, averageCost: 200, marketValue: -900 }
  ];

  it("finds the position by exact symbol", () => {
    expect(matchPosition(positions, "AAPL")?.symbol).toBe("AAPL");
  });

  it("matches case-insensitively and trims whitespace (normalizeSymbol)", () => {
    expect(matchPosition(positions, " aapl ")?.symbol).toBe("AAPL");
  });

  it("returns undefined when nothing is held in that symbol", () => {
    expect(matchPosition(positions, "MSFT")).toBeUndefined();
  });

  it("returns undefined for an empty/undefined position list", () => {
    expect(matchPosition(undefined, "AAPL")).toBeUndefined();
    expect(matchPosition([], "AAPL")).toBeUndefined();
  });
});

describe("effectiveOrderPrice — held position's own mark beats the market-scan cache", () => {
  const heldLong: EquityPosition = { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_250 };
  const scan = { price: 118, asOf: "2026-07-15T13:50:00.000Z", provider: "yahoo-finance" };

  it("prefers the position's own mark when the symbol is held, even with a scan price available", () => {
    expect(effectiveOrderPrice(heldLong, scan)).toEqual({ price: 125, source: "position" });
  });

  it("falls back to the scan price when the symbol isn't held", () => {
    expect(effectiveOrderPrice(undefined, scan)).toEqual({
      price: 118,
      source: "scan",
      asOf: scan.asOf,
      provider: scan.provider
    });
  });

  it("returns null when neither a held position nor a scan price is available", () => {
    expect(effectiveOrderPrice(undefined, null)).toBeNull();
  });

  it("falls back to the scan when the position is flat (nothing to mark)", () => {
    const flat: EquityPosition = { symbol: "AAPL", quantity: 0, averageCost: 100, marketValue: 0 };
    expect(effectiveOrderPrice(flat, scan)).toEqual({
      price: 118,
      source: "scan",
      asOf: scan.asOf,
      provider: scan.provider
    });
  });
});

describe("closingOrderPnl — estimated P/L for open orders that would close/reduce a position", () => {
  const heldLong: EquityPosition = { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_200 };
  const heldShort: EquityPosition = { symbol: "TSLA", quantity: -10, averageCost: 200, marketValue: -1_600 };

  it("estimates P/L for a sell-of-long using the order's unfilled remainder", () => {
    const sell = order({ symbol: "AAPL", side: "sell", quantity: 10, filledQuantity: 4 });
    const remaining = 6; // mirrors remainingQuantity(sell)
    const price = { price: 130, source: "position" as const };
    expect(closingOrderPnl(sell, remaining, heldLong, price)).toEqual({
      pnl: 180, // (130 - 100) * 6
      pnlPct: 30,
      basisPrice: 100,
      currentPrice: 130,
      shares: 6
    });
  });

  it("estimates P/L for a cover-of-short (buy reported by Alpaca), sign-flipped vs. a long", () => {
    const cover = order({ symbol: "TSLA", side: "buy", quantity: 10, filledQuantity: 0 });
    const price = { price: 160, source: "position" as const };
    expect(closingOrderPnl(cover, 10, heldShort, price)).toEqual({
      pnl: 400, // (200 - 160) * 10
      pnlPct: 20,
      basisPrice: 200,
      currentPrice: 160,
      shares: 10
    });
  });

  it("is null for an opening order (buy against a long, or sell against a short)", () => {
    const openingBuy = order({ symbol: "AAPL", side: "buy" });
    expect(closingOrderPnl(openingBuy, 10, heldLong, { price: 130, source: "position" })).toBeNull();
    const openingShort = order({ symbol: "TSLA", side: "short" });
    expect(closingOrderPnl(openingShort, 10, heldShort, { price: 160, source: "position" })).toBeNull();
  });

  it("is null when there's no matching held position", () => {
    const sell = order({ symbol: "MSFT", side: "sell" });
    expect(closingOrderPnl(sell, 10, undefined, { price: 300, source: "scan" })).toBeNull();
  });

  it("is null when no price is available", () => {
    const sell = order({ symbol: "AAPL", side: "sell" });
    expect(closingOrderPnl(sell, 10, heldLong, null)).toBeNull();
  });

  it("is null when the order's unfilled remainder is zero (fully filled)", () => {
    const filled = order({ symbol: "AAPL", side: "sell" });
    expect(closingOrderPnl(filled, 0, heldLong, { price: 130, source: "position" })).toBeNull();
  });
});
