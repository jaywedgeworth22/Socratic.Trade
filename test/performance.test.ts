import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { mergeQuoteData } from "../src/lib/market";
import {
  calculatePnl,
  getPaperPortfolioProjection,
  getRegimeScorecard,
  getThesisScorecard,
  recordFillFromProposal
} from "../src/lib/performance";
import type { FillEvent, MarketScan } from "../src/lib/types";

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

  it("uses share-weighted average cost for fractional Paper buys", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    insertFillEvent(fill({ id: "pb2", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: "PAPER2", symbol: "PLTR" }));
    insertFillEvent(fill({ id: "pb3", side: "buy", quantity: 0.5, price: 200, notional: 100, accountNumber: "PAPER2", symbol: "PLTR" }));

    const projection = getPaperPortfolioProjection({
      accountNumber: "PAPER2",
      startingCash: 1000,
      currentPrices: { PLTR: 220 }
    });

    const pltr = projection.positions.find((position) => position.symbol === "PLTR");
    expect(pltr?.quantity).toBeCloseTo(1.5);
    expect(pltr?.averageCost).toBeCloseTo(133.3333333, 5);
    expect(projection.portfolio.cash).toBeCloseTo(800);
  });

  it("turns approved dollar Paper orders into quantity fills when a market quote is present", () => {
    const fill = recordFillFromProposal({
      accountNumber: "APPROVAL1",
      source: "paper",
      proposal: {
        symbol: "MSFT",
        side: "buy",
        type: "market",
        dollarAmount: 10,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "test",
        tradeThesisTag: "test",
        entryMarketRegime: "test"
      },
      review: { estimatedNotional: 10, alerts: [], raw: {} },
      marketScan: marketScanWithQuote("MSFT", 420),
      status: "filled"
    });

    expect(fill.price).toBeCloseTo(420);
    expect(fill.quantity).toBeCloseTo(10 / 420);

    const projection = getPaperPortfolioProjection({ accountNumber: "APPROVAL1", startingCash: 100, currentPrices: { MSFT: 420 } });
    expect(projection.portfolio.cash).toBeCloseTo(90);
    expect(projection.positions.find((position) => position.symbol === "MSFT")?.quantity).toBeCloseTo(10 / 420);
  });

  it("keeps broker-only approval quotes in the market scan price map", () => {
    const scan = mergeQuoteData(emptyScan(), {
      MSFT: { price: 420, bid: 419.5, ask: 420.5, provider: "mock-robinhood", asOf: "2026-06-15T00:00:00.000Z" }
    });

    expect(scan.quotesBySymbol.MSFT?.price).toBeCloseTo(420);
    expect(scan.quotesBySymbol.MSFT?.ask).toBeCloseTo(420.5);
  });
});

describe("getThesisScorecard", () => {
  it("attributes realized P&L to the thesis a position was opened under", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "SCORE1";
    // Winner opened under "Momentum": buy 1 @ 100, sell 1 @ 120 => +20 (+20%).
    insertFillEvent(
      fill({
        id: "sc-b1",
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        accountNumber: account,
        symbol: "AAPL",
        filledAt: "2026-06-15T00:00:01.000Z",
        raw: { proposal: { tradeThesisTag: "Momentum", entryMarketRegime: "Tech-Bull" } }
      })
    );
    insertFillEvent(
      fill({
        id: "sc-s1",
        side: "sell",
        quantity: 1,
        price: 120,
        notional: 120,
        accountNumber: account,
        symbol: "AAPL",
        filledAt: "2026-06-15T00:00:02.000Z"
      })
    );
    // Loser opened under "MeanReversion": buy 1 @ 100, sell 1 @ 90 => -10 (-10%).
    insertFillEvent(
      fill({
        id: "sc-b2",
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        accountNumber: account,
        symbol: "MSFT",
        filledAt: "2026-06-15T00:00:03.000Z",
        raw: { proposal: { tradeThesisTag: "MeanReversion", entryMarketRegime: "Choppy" } }
      })
    );
    insertFillEvent(
      fill({
        id: "sc-s2",
        side: "sell",
        quantity: 1,
        price: 90,
        notional: 90,
        accountNumber: account,
        symbol: "MSFT",
        filledAt: "2026-06-15T00:00:04.000Z"
      })
    );

    const scorecard = getThesisScorecard(account, "paper");

    // Sorted by total P&L descending: winner first.
    expect(scorecard.map((s) => s.thesisTag)).toEqual(["Momentum", "MeanReversion"]);

    const momentum = scorecard.find((s) => s.thesisTag === "Momentum")!;
    expect(momentum.trades).toBe(1);
    expect(momentum.winRate).toBe(100);
    expect(momentum.avgReturnPct).toBeCloseTo(20);
    expect(momentum.totalPnl).toBeCloseTo(20);
    // Bayesian shrinkage (5-trade neutral prior) tempers the 1-trade sample:
    // win rate (1 + 2.5)/(1 + 5) = 58%; avg return 20/(1 + 5) = 3.33%.
    expect(momentum.shrunkWinRate).toBe(58);
    expect(momentum.shrunkAvgReturnPct).toBeCloseTo(3.33);

    const reversion = scorecard.find((s) => s.thesisTag === "MeanReversion")!;
    expect(reversion.winRate).toBe(0);
    expect(reversion.avgReturnPct).toBeCloseTo(-10);
    expect(reversion.totalPnl).toBeCloseTo(-10);

    // Same closed lots, grouped by the regime each was opened in.
    const regimes = getRegimeScorecard(account, "paper");
    expect(regimes.map((r) => r.regime)).toEqual(["Tech-Bull", "Choppy"]);
    expect(regimes.find((r) => r.regime === "Tech-Bull")!.totalPnl).toBeCloseTo(20);
    expect(regimes.find((r) => r.regime === "Choppy")!.winRate).toBe(0);
  });

  it("buckets fills with no thesis tag under 'Untagged'", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "SCORE2";
    insertFillEvent(fill({ id: "u-b1", side: "buy", quantity: 1, price: 50, notional: 50, accountNumber: account, symbol: "T", filledAt: "2026-06-15T00:00:01.000Z" }));
    insertFillEvent(fill({ id: "u-s1", side: "sell", quantity: 1, price: 55, notional: 55, accountNumber: account, symbol: "T", filledAt: "2026-06-15T00:00:02.000Z" }));

    const scorecard = getThesisScorecard(account, "paper");
    expect(scorecard).toHaveLength(1);
    expect(scorecard[0].thesisTag).toBe("Untagged");
    expect(scorecard[0].totalPnl).toBeCloseTo(5);
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

function emptyScan(): MarketScan {
  return {
    source: "test",
    generatedAt: "2026-06-15T00:00:00.000Z",
    scannedSymbols: 0,
    returnedQuotes: 0,
    topCandidates: [],
    sectorBySymbol: {},
    quotesBySymbol: {},
    warnings: []
  };
}

function marketScanWithQuote(symbol: string, price: number): MarketScan {
  return {
    ...emptyScan(),
    scannedSymbols: 1,
    returnedQuotes: 1,
    quotesBySymbol: {
      [symbol]: {
        symbol,
        price,
        score: 0
      }
    }
  };
}
