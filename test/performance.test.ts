import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { mergeQuoteData } from "../src/lib/market";
import {
  calculatePnl,
  getClosedLotCount,
  getConfidenceCalibration,
  getFactorScorecard,
  getPaperPortfolioProjection,
  getRegimeScorecard,
  getSectorScorecard,
  getSignalEfficacy,
  getSkippedCandidateReturns,
  getThesisRegimeScorecard,
  getThesisScorecard,
  recordFillFromProposal
} from "../src/lib/performance";
import type { FillEvent, MarketScan, OrderSide } from "../src/lib/types";

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

  it("keeps Paper projections isolated by user for the same account number", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "PAPER_USERS";
    const userA = `paper-a-${randomUUID()}`;
    const userB = `paper-b-${randomUUID()}`;

    insertFillEvent(fill({ id: "pu-a", userId: userA, accountNumber: account, symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100 }));
    insertFillEvent(fill({ id: "pu-b", userId: userB, accountNumber: account, symbol: "MSFT", side: "buy", quantity: 1, price: 200, notional: 200 }));

    const projection = getPaperPortfolioProjection({
      accountNumber: account,
      startingCash: 1000,
      currentPrices: { AAPL: 110, MSFT: 220 },
      userId: userA
    });

    expect(projection.positions.map((position) => position.symbol)).toEqual(["AAPL"]);
    expect(projection.portfolio.cash).toBeCloseTo(900);
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

  it("crosses thesis and regime into combined buckets and counts closed lots", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "SCORE_TR";
    // Two closed lots under the same thesis but different regimes.
    insertFillEvent(fill({ id: "tr-b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:01.000Z", raw: { proposal: { tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "Tech-Bull" } } }));
    insertFillEvent(fill({ id: "tr-s1", side: "sell", quantity: 1, price: 130, notional: 130, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:02.000Z" }));
    insertFillEvent(fill({ id: "tr-b2", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "BBB", filledAt: "2026-06-15T00:00:03.000Z", raw: { proposal: { tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "High-Vol" } } }));
    insertFillEvent(fill({ id: "tr-s2", side: "sell", quantity: 1, price: 80, notional: 80, accountNumber: account, symbol: "BBB", filledAt: "2026-06-15T00:00:04.000Z" }));

    const combined = getThesisRegimeScorecard(account, "paper");
    expect(combined.map((b) => `${b.thesisTag} @ ${b.regime}`).sort()).toEqual(["Momentum-Breakout @ High-Vol", "Momentum-Breakout @ Tech-Bull"]);
    expect(combined.find((b) => b.regime === "Tech-Bull")!.totalPnl).toBeCloseTo(30);
    expect(combined.find((b) => b.regime === "High-Vol")!.totalPnl).toBeCloseTo(-20);
    expect(getClosedLotCount(account, "paper")).toBe(2);
  });

  it("attributes realized win rate to entry signals via the signal_snapshot join", async () => {
    const { insertFillEvent, audit } = await import("../src/lib/db");
    const account = "SIGEFF1";
    const runId = "run-sigeff-1";
    // A winning buy (100 -> 130) opened in a run that recorded a congressional + insider tailwind.
    insertFillEvent(fill({ id: "se-b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "NVDA", runId, filledAt: "2026-06-15T00:00:01.000Z" }));
    insertFillEvent(fill({ id: "se-s1", side: "sell", quantity: 1, price: 130, notional: 130, accountNumber: account, symbol: "NVDA", filledAt: "2026-06-15T00:00:02.000Z" }));
    // The snapshot now records the full scored set; the skipped TSLA entry (chosen:false,
    // no fill) must NOT inflate any signal bucket. The NVDA entry has no `chosen` field
    // (older shape) and must still attribute, proving backward compatibility.
    audit("signal_snapshot", {
      runId,
      signals: [
        { symbol: "NVDA", side: "buy", congressNet: 2, insiderSentiment: 80 },
        { symbol: "TSLA", chosen: false, congressNet: 5, insiderSentiment: 90 }
      ]
    });

    const eff = getSignalEfficacy(account, "paper");
    expect(eff.find((e) => e.signal.includes("baseline"))?.trades).toBe(1);
    const congress = eff.find((e) => e.signal.includes("Congressional"));
    expect(congress?.trades).toBe(1); // only NVDA, not the skipped TSLA
    expect(congress?.winRate).toBe(100);
    expect(eff.find((e) => e.signal.includes("Insider"))?.trades).toBe(1);
  });

  it("keeps signal efficacy audit joins isolated by user", async () => {
    const { insertFillEvent, audit } = await import("../src/lib/db");
    const account = "SIGEFF_USERS";
    const userA = `sig-a-${randomUUID()}`;
    const userB = `sig-b-${randomUUID()}`;
    const runId = "run-sigeff-users";

    insertFillEvent(fill({ id: "seu-b1", userId: userA, side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAPL", runId, filledAt: "2026-06-15T00:00:01.000Z" }));
    insertFillEvent(fill({ id: "seu-s1", userId: userA, side: "sell", quantity: 1, price: 110, notional: 110, accountNumber: account, symbol: "AAPL", filledAt: "2026-06-15T00:00:02.000Z" }));
    audit("signal_snapshot", { runId, signals: [{ symbol: "AAPL", chosen: true, congressNet: 2 }] }, userB);

    const eff = getSignalEfficacy(account, "paper", {}, userA);
    expect(eff.find((e) => e.signal.includes("baseline"))?.trades).toBe(1);
    expect(eff.find((e) => e.signal.includes("Congressional"))).toBeUndefined();
  });

  it("buckets realized outcomes by the dominant entry factor", async () => {
    const { insertFillEvent, audit } = await import("../src/lib/db");
    const account = "FACTOR1";
    const userId = `factor-user-${randomUUID()}`;
    const runId = "run-factor-1";

    insertFillEvent(fill({ id: "fb-b1", userId, side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAPL", runId, filledAt: "2026-06-15T00:00:01.000Z" }));
    insertFillEvent(fill({ id: "fb-s1", userId, side: "sell", quantity: 1, price: 125, notional: 125, accountNumber: account, symbol: "AAPL", filledAt: "2026-06-15T00:00:02.000Z" }));
    audit("signal_snapshot", {
      runId,
      signals: [
        {
          symbol: "AAPL",
          chosen: true,
          factorBreakdown: { liquidity: 10, momentum: 90, value: 30, quality: 20, volatility: 15, sentiment: 25, positioning: 40, diversification: 5, weightedTotal: 70 }
        },
        {
          symbol: "MSFT",
          chosen: false,
          factorBreakdown: { liquidity: 10, momentum: 5, value: 95, quality: 20, volatility: 15, sentiment: 25, positioning: 40, diversification: 5, weightedTotal: 70 }
        }
      ]
    }, userId);

    const factors = getFactorScorecard(account, "paper", {}, userId);
    expect(factors).toHaveLength(1);
    expect(factors[0].factor).toBe("momentum");
    expect(factors[0].totalPnl).toBeCloseTo(25);
  });

  it("summarizes skipped candidate counterfactual returns from user-scoped snapshots", async () => {
    const { audit } = await import("../src/lib/db");
    const userA = `skip-a-${randomUUID()}`;
    const userB = `skip-b-${randomUUID()}`;
    const asOf = new Date().toISOString();

    audit("signal_snapshot", {
      runId: "run-skip-a",
      asOf,
      signals: [{ symbol: "AAPL", chosen: false, refPrice: 100, score: 80, regime: "Risk-On", factorBreakdown: { liquidity: 10, momentum: 90, value: 30, quality: 20, volatility: 15, sentiment: 25, positioning: 40, diversification: 5, weightedTotal: 70 } }]
    }, userA);
    audit("signal_snapshot", {
      runId: "run-skip-b",
      asOf,
      signals: [{ symbol: "AAPL", chosen: false, refPrice: 50, score: 80, regime: "Risk-On" }]
    }, userB);

    const rows = getSkippedCandidateReturns({ AAPL: 110 }, userA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: "run-skip-a", symbol: "AAPL", returnPct: 10, dominantFactor: "momentum" });
  });

  it("groups realized outcomes by the sector each position was opened in", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "SECT1";
    insertFillEvent(fill({ id: "sec-b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:01.000Z", raw: { proposal: { tradeThesisTag: "T" }, sector: "Technology" } }));
    insertFillEvent(fill({ id: "sec-s1", side: "sell", quantity: 1, price: 120, notional: 120, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:02.000Z" }));
    const sc = getSectorScorecard(account, "paper");
    expect(sc.find((s) => s.sector === "Technology")?.totalPnl).toBeCloseTo(20);
  });

  it("buckets realized outcomes by the agent's entry confidence band", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "CONF1";
    // High-confidence winner (90 → +20%).
    insertFillEvent(fill({ id: "cf-b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:01.000Z", raw: { proposal: { tradeThesisTag: "T", confidenceScore: 90 } } }));
    insertFillEvent(fill({ id: "cf-s1", side: "sell", quantity: 1, price: 120, notional: 120, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:02.000Z" }));
    // Low-confidence loser (40 → −10%).
    insertFillEvent(fill({ id: "cf-b2", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "BBB", filledAt: "2026-06-15T00:00:03.000Z", raw: { proposal: { tradeThesisTag: "T", confidenceScore: 40 } } }));
    insertFillEvent(fill({ id: "cf-s2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: account, symbol: "BBB", filledAt: "2026-06-15T00:00:04.000Z" }));

    const cal = getConfidenceCalibration(account, "paper");
    expect(cal.find((c) => c.band.startsWith("85"))?.winRate).toBe(100);
    expect(cal.find((c) => c.band.startsWith("1-49"))?.winRate).toBe(0);
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

describe("calculatePnl — short/cover", () => {
  it("short then cover at a lower price realizes a profit (price fell)", () => {
    const fills: FillEvent[] = [
      fill({ id: "sh1", side: "short", quantity: 1, price: 120, notional: 120, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "cv1", side: "cover", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    const pnl = calculatePnl(fills);
    expect(pnl.realized).toBeCloseTo(20);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("short");
    expect(pnl.openLots).toHaveLength(0);
  });

  it("short then cover at a higher price realizes a loss (price rose)", () => {
    const fills: FillEvent[] = [
      fill({ id: "sh2", side: "short", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "cv2", side: "cover", quantity: 1, price: 130, notional: 130, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    expect(calculatePnl(fills).realized).toBeCloseTo(-30);
  });

  it("marks an open short to market with the short sign (profit when below entry)", () => {
    const pnl = calculatePnl(
      [fill({ id: "sh3", side: "short", quantity: 1, price: 120, notional: 120, filledAt: "2026-06-15T00:00:01.000Z" })],
      { AAPL: 100 }
    );
    expect(pnl.unrealized).toBeCloseTo(20);
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("short");
  });

  it("a sell skips a leading short lot and realizes against the long lot (no $0 erasure)", () => {
    const fills: FillEvent[] = [
      fill({ id: "x-sh", side: "short", quantity: 1, price: 90, notional: 90, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "x-b", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:02.000Z" }),
      fill({ id: "x-s", side: "sell", quantity: 1, price: 130, notional: 130, filledAt: "2026-06-15T00:00:03.000Z" })
    ];
    const pnl = calculatePnl(fills);
    // The sell closes the LONG lot (+30); the short lot is NOT consumed at $0.
    expect(pnl.realized).toBeCloseTo(30);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("long");
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("short");
  });

  it("a cover skips a leading long lot and realizes against the short lot", () => {
    const fills: FillEvent[] = [
      fill({ id: "y-b", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "y-sh", side: "short", quantity: 1, price: 120, notional: 120, filledAt: "2026-06-15T00:00:02.000Z" }),
      fill({ id: "y-cv", side: "cover", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:03.000Z" })
    ];
    const pnl = calculatePnl(fills);
    expect(pnl.realized).toBeCloseTo(20);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("short");
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("long");
  });
});

function fill(input: Partial<FillEvent> & { id: string; side: OrderSide; quantity: number; price: number; notional: number; userId?: string }): FillEvent {
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
