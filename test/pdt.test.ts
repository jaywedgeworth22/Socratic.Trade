import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal, PDT_EQUITY_THRESHOLD, PDT_MAX_DAY_TRADES } from "../src/lib/policy";
import type { OrderSide, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

// Pattern-Day-Trader gate (FINRA Rule 4210). Owner-resolved decisions under test:
//   day-trade   = same-symbol round-trip OPENED and CLOSED on the same NY calendar day
//   lookback    = rolling 5 business days
//   equity      = Portfolio.totalMarketValue
//   threshold   = $25,000
//   action      = BLOCK the opening leg that would enable a 4th day-trade
//   scope       = LIVE/brokerage execution ONLY (Test/paper are never gated)

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-pdt-${randomUUID()}.db`)}`;
});

// asOf = Friday 2026-06-19. The 5-business-day window walks back Fri 6/19 → Mon 6/15 (inclusive).
const AS_OF = new Date("2026-06-19T18:00:00.000Z"); // 2pm EDT Fri

const policy: TradingPolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  paperMode: false,
  strategyAuthority: "decide",
  accountNumber: "LIVE1",
  includedIndices: [],
  additionalSymbols: ["AAPL", "MSFT", "NVDA", "TSLA"]
};

function portfolioWithEquity(equity: number, accountNumber = "LIVE1"): Portfolio {
  return {
    accountNumber,
    totalMarketValue: equity,
    buyingPower: equity,
    equityMarketValue: equity,
    optionMarketValue: 0,
    cash: equity
  };
}

const openingProposal: TradeProposal = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 100,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "test",
  entryMarketRegime: "test"
};

// Seed N distinct same-day round-trips (one symbol+day each) for an account, each on its own
// market day inside the 5-business-day window. Returns nothing — fills are persisted.
async function seedDayTrades(accountNumber: string, source: "live" | "paper", count: number) {
  const { insertFillEvent } = await import("../src/lib/db");
  // Each entry is a market day (NY) inside the window Mon 6/15 .. Fri 6/19; afternoon EDT timestamps.
  const days = ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"];
  const symbols = ["AAPL", "MSFT", "NVDA", "TSLA", "AMD"];
  for (let i = 0; i < count; i += 1) {
    const day = days[i];
    const symbol = symbols[i];
    const open = `${day}T17:00:00.000Z`; // 1pm EDT
    const close = `${day}T18:30:00.000Z`; // 2:30pm EDT, same NY day
    insertFillEvent({
      id: `${accountNumber}-${symbol}-open`,
      accountNumber,
      source,
      symbol,
      side: "buy" as OrderSide,
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled",
      filledAt: open
    });
    insertFillEvent({
      id: `${accountNumber}-${symbol}-close`,
      accountNumber,
      source,
      symbol,
      side: "sell" as OrderSide,
      quantity: 1,
      price: 110,
      notional: 110,
      status: "filled",
      filledAt: close
    });
  }
}

describe("countDayTradesInLastBusinessDays", () => {
  it("counts a same-day round-trip per symbol+day and excludes orphan legs", async () => {
    const { insertFillEvent, countDayTradesInLastBusinessDays } = await import("../src/lib/db");
    const account = "COUNT1";
    // Two qualifying round-trips on two business days (buy+sell same NY day each).
    insertFillEvent({ id: "c1o", accountNumber: account, source: "live", symbol: "AAPL", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-16T17:00:00.000Z" });
    insertFillEvent({ id: "c1c", accountNumber: account, source: "live", symbol: "AAPL", side: "sell", quantity: 1, price: 105, notional: 105, status: "filled", filledAt: "2026-06-16T18:00:00.000Z" });
    insertFillEvent({ id: "c2o", accountNumber: account, source: "live", symbol: "MSFT", side: "buy", quantity: 1, price: 200, notional: 200, status: "filled", filledAt: "2026-06-17T17:00:00.000Z" });
    insertFillEvent({ id: "c2c", accountNumber: account, source: "live", symbol: "MSFT", side: "sell", quantity: 1, price: 210, notional: 210, status: "filled", filledAt: "2026-06-17T18:00:00.000Z" });
    // Orphan: an open with no same-day close → NOT a day-trade.
    insertFillEvent({ id: "c3o", accountNumber: account, source: "live", symbol: "NVDA", side: "buy", quantity: 1, price: 50, notional: 50, status: "filled", filledAt: "2026-06-18T17:00:00.000Z" });
    // Different calendar days for the same symbol → buy on one day, sell on the next → NOT a day-trade.
    insertFillEvent({ id: "c4o", accountNumber: account, source: "live", symbol: "TSLA", side: "buy", quantity: 1, price: 60, notional: 60, status: "filled", filledAt: "2026-06-15T18:00:00.000Z" });
    insertFillEvent({ id: "c4c", accountNumber: account, source: "live", symbol: "TSLA", side: "sell", quantity: 1, price: 65, notional: 65, status: "filled", filledAt: "2026-06-16T15:00:00.000Z" });

    expect(countDayTradesInLastBusinessDays(account, 5, AS_OF)).toBe(2);
  });

  it("counts a short→cover same-day round-trip and respects the rolling window edge", async () => {
    const { insertFillEvent, countDayTradesInLastBusinessDays } = await import("../src/lib/db");
    const account = "COUNT2";
    // short→cover same NY day inside the window → a day-trade.
    insertFillEvent({ id: "s1o", accountNumber: account, source: "live", symbol: "AAPL", side: "short", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-17T17:00:00.000Z" });
    insertFillEvent({ id: "s1c", accountNumber: account, source: "live", symbol: "AAPL", side: "cover", quantity: 1, price: 95, notional: 95, status: "filled", filledAt: "2026-06-17T18:00:00.000Z" });
    // A round-trip on Fri 6/12 — one business day BEFORE the window start (Mon 6/15) → excluded.
    insertFillEvent({ id: "s2o", accountNumber: account, source: "live", symbol: "MSFT", side: "buy", quantity: 1, price: 200, notional: 200, status: "filled", filledAt: "2026-06-12T17:00:00.000Z" });
    insertFillEvent({ id: "s2c", accountNumber: account, source: "live", symbol: "MSFT", side: "sell", quantity: 1, price: 205, notional: 205, status: "filled", filledAt: "2026-06-12T18:00:00.000Z" });

    expect(countDayTradesInLastBusinessDays(account, 5, AS_OF)).toBe(1);
  });
});

describe("evaluateTradeProposal — PDT gate", () => {
  function evaluate(opts: {
    equity: number;
    isLiveExecution?: boolean;
    priorDayTradeCount?: number;
    proposal?: TradeProposal;
    accountNumber?: string;
  }) {
    return evaluateTradeProposal(opts.proposal ?? openingProposal, {
      policy: { ...policy, accountNumber: opts.accountNumber ?? "LIVE1" },
      portfolio: portfolioWithEquity(opts.equity, opts.accountNumber ?? "LIVE1"),
      positions: [],
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 100,
      isLiveExecution: opts.isLiveExecution,
      priorDayTradeCount: opts.priorDayTradeCount
    });
  }

  it("BLOCKS an opening LIVE order with equity < $25k and 3 prior day-trades", async () => {
    await seedDayTrades("PDT-BLOCK", "live", 3);
    const { countDayTradesInLastBusinessDays } = await import("../src/lib/db");
    const prior = countDayTradesInLastBusinessDays("PDT-BLOCK", 5, AS_OF);
    expect(prior).toBe(PDT_MAX_DAY_TRADES); // exactly 3 — the next opening trade would be the 4th

    const decision = evaluate({ equity: PDT_EQUITY_THRESHOLD - 1, isLiveExecution: true, priorDayTradeCount: prior });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("pdt_rule"))).toBe(true);
  });

  it("does NOT block when equity >= $25k even with 3 prior day-trades", () => {
    const decision = evaluate({ equity: PDT_EQUITY_THRESHOLD, isLiveExecution: true, priorDayTradeCount: 3 });
    expect(decision.reasons.some((r) => r.includes("pdt_rule"))).toBe(false);
    expect(decision.approved).toBe(true);
  });

  it("does NOT block a paper/Test account (not live) regardless of equity or day-trade count", () => {
    // Low equity (< $25k) with many day-trades: the ONLY reason that must be absent is pdt_rule.
    // (Other notional/exposure caps may legitimately fire at this equity — they are not the PDT gate.)
    const decisionUndefined = evaluate({ equity: 1000, isLiveExecution: undefined, priorDayTradeCount: 10 });
    expect(decisionUndefined.reasons.some((r) => r.includes("pdt_rule"))).toBe(false);

    const decisionFalse = evaluate({ equity: 1000, isLiveExecution: false, priorDayTradeCount: 10 });
    expect(decisionFalse.reasons.some((r) => r.includes("pdt_rule"))).toBe(false);

    // And with ample equity a paper account is fully approved (no caps bind either).
    const decisionPaperHighEquity = evaluate({ equity: 100_000, isLiveExecution: false, priorDayTradeCount: 10 });
    expect(decisionPaperHighEquity.reasons.some((r) => r.includes("pdt_rule"))).toBe(false);
    expect(decisionPaperHighEquity.approved).toBe(true);
  });

  it("does NOT block when fewer than 3 prior day-trades", () => {
    // Sub-threshold equity but only 2 prior day-trades → PDT gate must not fire.
    const decision = evaluate({ equity: 1000, isLiveExecution: true, priorDayTradeCount: PDT_MAX_DAY_TRADES - 1 });
    expect(decision.reasons.some((r) => r.includes("pdt_rule"))).toBe(false);

    // With ample equity and 2 prior day-trades the LIVE opening order is fully approved.
    const highEquity = evaluate({ equity: 100_000, isLiveExecution: true, priorDayTradeCount: PDT_MAX_DAY_TRADES - 1 });
    expect(highEquity.reasons.some((r) => r.includes("pdt_rule"))).toBe(false);
    expect(highEquity.approved).toBe(true);
  });

  it("does NOT falsely block a CLOSING order (sell) even when over the PDT limit", () => {
    const sell: TradeProposal = { ...openingProposal, symbol: "AAPL", side: "sell", dollarAmount: undefined, quantity: 1 };
    const decision = evaluate({ equity: 1000, isLiveExecution: true, priorDayTradeCount: 5, proposal: sell });
    expect(decision.reasons.some((r) => r.includes("pdt_rule"))).toBe(false);
  });

  it("blocks an opening SHORT the same way as a buy", () => {
    const short: TradeProposal = { ...openingProposal, symbol: "AAPL", side: "short" };
    const decision = evaluate({ equity: 1000, isLiveExecution: true, priorDayTradeCount: 4, proposal: short });
    expect(decision.reasons.some((r) => r.includes("pdt_rule"))).toBe(true);
  });
});
