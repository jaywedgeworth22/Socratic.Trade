import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { calculatePnl, getPaperPortfolioProjection } from "../src/lib/performance";
import type { FillEvent } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-performance-${randomUUID()}.db`)}`;
});

describe("calculatePnl", () => {
  it("uses FIFO realized P&L and marks remaining lots to market", () => {
    const fills: FillEvent[] = [
      fill({ id: "b1", side: "buy", quantity: 2, price: 100, notional: 200 }),
      fill({ id: "b2", side: "buy", quantity: 1, price: 120, notional: 120 }),
      fill({ id: "s1", side: "sell", quantity: 1.5, price: 130, notional: 195 })
    ];

    const pnl = calculatePnl(fills, { AAPL: 125 });

    expect(pnl.realized).toBeCloseTo(45);
    expect(pnl.unrealized).toBeCloseTo(17.5);
    expect(pnl.closedLots.length).toBe(1);
  });

  it("projects Paper fills from a standalone starting balance and marks to live prices", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    // Standalone paper account: only paper fills count, starting from startingCash.
    insertFillEvent(fill({ id: "pb1", side: "buy", quantity: 1, price: 200, notional: 200, accountNumber: "PAPER1" }));

    const projection = getPaperPortfolioProjection({
      accountNumber: "PAPER1",
      startingCash: 10000,
      currentPrices: { AAPL: 250 }
    });

    // Cash reduced by the buy notional; no dependence on any real brokerage positions.
    expect(projection.portfolio.cash).toBeCloseTo(9800);
    const aapl = projection.positions.find((position) => position.symbol === "AAPL");
    expect(aapl?.quantity).toBeCloseTo(1);
    // Marked to the supplied live price (250), not entry price (200).
    expect(aapl?.marketValue).toBeCloseTo(250);
    expect(projection.portfolio.totalMarketValue).toBeCloseTo(10050);
  });

  it("returns the full starting balance and no positions before any Paper fills", () => {
    const projection = getPaperPortfolioProjection({ accountNumber: "EMPTY1", startingCash: 5000 });
    expect(projection.portfolio.cash).toBeCloseTo(5000);
    expect(projection.portfolio.totalMarketValue).toBeCloseTo(5000);
    expect(projection.positions).toHaveLength(0);
  });
});

function fill(input: Partial<FillEvent> & { id: string; side: "buy" | "sell"; quantity: number; price: number; notional: number }): FillEvent {
  return {
    proposalId: "p1",
    runId: "r1",
    accountNumber: "A1",
    source: "paper",
    symbol: "AAPL",
    status: "filled",
    brokerOrderId: undefined,
    raw: undefined,
    filledAt: `2026-06-15T00:00:0${input.id === "s1" ? 3 : input.id === "b2" ? 2 : 1}.000Z`,
    ...input
  };
}
