/**
 * C2 — FIFO P&L compute-once:
 *  When PrefetchedPnl is supplied, scorecards / performance / open-lots must not
 *  re-enter calculatePnl. Numbers must match a fresh calculatePnl on the same fills.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { FillEvent } from "../src/lib/types";
import {
  calculatePnl,
  getCalculatePnlCallCountForTests,
  getClosedLotsDetailed,
  getOpenLots,
  getPerformanceSummary,
  getThesisScorecard,
  resetCalculatePnlCallCountForTests
} from "../src/lib/performance";

afterEach(() => {
  resetCalculatePnlCallCountForTests();
});

function fill(partial: Partial<FillEvent> & Pick<FillEvent, "symbol" | "side" | "quantity" | "price" | "filledAt">): FillEvent {
  return {
    id: partial.id ?? `f-${partial.symbol}-${partial.filledAt}`,
    accountNumber: partial.accountNumber ?? "TEST",
    source: partial.source ?? "paper",
    status: partial.status ?? "filled",
    runId: partial.runId,
    proposalId: partial.proposalId,
    symbol: partial.symbol,
    side: partial.side,
    quantity: partial.quantity,
    price: partial.price,
    notional: partial.notional ?? partial.quantity * partial.price,
    filledAt: partial.filledAt,
    raw: partial.raw
  };
}

describe("prefetchedPnl compute-once", () => {
  it("getThesisScorecard reuses closedLots without calling calculatePnl again", () => {
    const fills: FillEvent[] = [
      fill({
        symbol: "AAPL",
        side: "buy",
        quantity: 10,
        price: 100,
        filledAt: "2026-01-01T10:00:00.000Z",
        raw: JSON.stringify({ tradeThesisTag: "momentum", entryMarketRegime: "Risk-On" })
      }),
      fill({
        symbol: "AAPL",
        side: "sell",
        quantity: 10,
        price: 110,
        filledAt: "2026-01-02T10:00:00.000Z"
      })
    ];
    const prices = { AAPL: 110 };
    const pnl = calculatePnl(fills, prices);
    resetCalculatePnlCallCountForTests();

    const card = getThesisScorecard("TEST", "paper", prices, "local", { paperFills: fills }, { paper: pnl });

    expect(getCalculatePnlCallCountForTests()).toBe(0);
    expect(card.length).toBeGreaterThan(0);
    expect(card[0].trades).toBe(1);
    expect(card[0].totalPnl).toBeCloseTo(100, 5);

    // Without prefetchedPnl, calculatePnl is used once.
    resetCalculatePnlCallCountForTests();
    getThesisScorecard("TEST", "paper", prices, "local", { paperFills: fills });
    expect(getCalculatePnlCallCountForTests()).toBe(1);
  });

  it("getPerformanceSummary uses live+paper PrefetchedPnl and matches fresh numbers", () => {
    const liveFills: FillEvent[] = [
      fill({
        symbol: "MSFT",
        side: "buy",
        quantity: 5,
        price: 200,
        filledAt: "2026-01-01T10:00:00.000Z",
        source: "live",
        accountNumber: "LIVE1"
      }),
      fill({
        symbol: "MSFT",
        side: "sell",
        quantity: 5,
        price: 220,
        filledAt: "2026-01-03T10:00:00.000Z",
        source: "live",
        accountNumber: "LIVE1"
      })
    ];
    const paperFills: FillEvent[] = [
      fill({
        symbol: "GOOG",
        side: "buy",
        quantity: 2,
        price: 100,
        filledAt: "2026-01-01T11:00:00.000Z",
        source: "paper"
      }),
      fill({
        symbol: "GOOG",
        side: "sell",
        quantity: 2,
        price: 90,
        filledAt: "2026-01-02T11:00:00.000Z",
        source: "paper"
      })
    ];
    const prices = { MSFT: 220, GOOG: 90 };
    const livePnl = calculatePnl(liveFills, prices);
    const paperPnl = calculatePnl(paperFills, prices);
    resetCalculatePnlCallCountForTests();

    const summary = getPerformanceSummary(
      "LIVE1",
      prices,
      "local",
      { liveFills, paperFills },
      { live: livePnl, paper: paperPnl }
    );

    expect(getCalculatePnlCallCountForTests()).toBe(0);
    expect(summary.liveRealizedPnl).toBeCloseTo(livePnl.realized, 5);
    expect(summary.paperRealizedPnl).toBeCloseTo(paperPnl.realized, 5);
    expect(summary.liveRealizedPnl).toBeCloseTo(100, 5); // 5 * (220-200)
    expect(summary.paperRealizedPnl).toBeCloseTo(-20, 5); // 2 * (90-100)
  });

  it("getClosedLotsDetailed / getOpenLots prefer PrefetchedPnl", () => {
    const fills: FillEvent[] = [
      fill({
        symbol: "X",
        side: "buy",
        quantity: 3,
        price: 50,
        filledAt: "2026-01-01T10:00:00.000Z"
      })
    ];
    const prices = { X: 60 };
    const pnl = calculatePnl(fills, prices);
    resetCalculatePnlCallCountForTests();

    const open = getOpenLots("TEST", "paper", "local", { paperFills: fills }, { paper: pnl });
    const closed = getClosedLotsDetailed("TEST", "paper", "local", { paperFills: fills }, { paper: pnl });

    expect(getCalculatePnlCallCountForTests()).toBe(0);
    expect(closed).toEqual(pnl.closedLots);
    expect(open).toEqual(pnl.openLots);
    expect(open).toHaveLength(1);
    expect(open[0].symbol).toBe("X");
  });
});
