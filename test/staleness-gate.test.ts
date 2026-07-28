import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-staleness-gate-${randomUUID()}.db`)}`;
});

vi.mock("../src/lib/tax", () => ({
  getUserWashSaleLockedSymbols: vi.fn((_userId: string) => new Set<string>()),
  getUserWashSaleLockProvenance: vi.fn((_userId: string) => new Map()),
}));

// import AFTER env + mock are set
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
import type { EquityPosition, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

const NOW = new Date("2026-06-26T15:00:00.000Z");

const portfolio: Portfolio = {
  accountNumber: "A1",
  totalMarketValue: 10000,
  buyingPower: 5000,
  equityMarketValue: 5000,
  optionMarketValue: 0,
  cash: 5000,
};

const positions: EquityPosition[] = [];

const basePolicy: TradingPolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  strategyAuthority: "decide",
  accountNumber: "A1",
  includedIndices: [],
  additionalSymbols: ["TSLA"],
};

const buyProposal: TradeProposal = {
  symbol: "TSLA",
  side: "buy",
  type: "market",
  dollarAmount: 10,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "test",
  entryMarketRegime: "test",
};

const sellProposal: TradeProposal = { ...buyProposal, side: "sell" };

function scanWith(asOf: string | undefined, generatedAt: string): MarketScan {
  return {
    source: "test",
    generatedAt,
    scannedSymbols: 1,
    returnedQuotes: 1,
    topCandidates: [{ symbol: "TSLA", price: 10, volume: 100, intradayChangePct: 0, positionMarketValue: 0, score: 1, asOf } as any],
    sectorBySymbol: {},
    quotesBySymbol: { TSLA: { symbol: "TSLA", price: 10, score: 1, asOf } as any },
    warnings: [],
  } as MarketScan;
}

function ctx(policy: TradingPolicy, marketScan?: MarketScan) {
  return {
    policy,
    portfolio,
    positions,
    dailyNotionalUsed: 0,
    dailyOrderCount: 0,
    estimatedNotional: 10,
    washSaleLockedSymbols: new Set<string>(),
    marketScan,
    now: NOW,
  };
}

const FRESH_GENERATED_AT = new Date(NOW.getTime() - 5_000).toISOString(); // 5s ago

describe("staleness gate", () => {
  it("blocks an opening buy whose quote is older than maxQuoteAgeSec", () => {
    const staleAsOf = new Date(NOW.getTime() - 600_000).toISOString(); // 600s ago
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const result = evaluateTradeProposal(buyProposal, ctx(policy, scanWith(staleAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes("staleness_gate") && r.includes("quote is"))).toBe(true);
  });

  it("allows an opening buy whose quote is fresh", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString(); // 10s ago
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const result = evaluateTradeProposal(buyProposal, ctx(policy, scanWith(freshAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
  });

  it("allows a quote exactly at the threshold (boundary, strictly-greater check)", () => {
    const exactAsOf = new Date(NOW.getTime() - 60_000).toISOString(); // exactly 60s ago
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const result = evaluateTradeProposal(buyProposal, ctx(policy, scanWith(exactAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
  });

  it("never blocks when the gate is OFF even with very old data", () => {
    const veryStaleAsOf = new Date(NOW.getTime() - 86_400_000).toISOString(); // 1 day ago
    const veryStaleGeneratedAt = new Date(NOW.getTime() - 86_400_000).toISOString();
    // maxQuoteAgeSec defaulted to 120 on 2026-07-28 (guard enablement); pin 0 to keep testing the
    // gate-OFF path.
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 0 };
    const result = evaluateTradeProposal(buyProposal, ctx(policy, scanWith(veryStaleAsOf, veryStaleGeneratedAt)));
    expect(result.approved).toBe(true);
    expect(result.reasons.every((r) => !r.includes("staleness_gate"))).toBe(true);
  });

  it("treats a missing quote timestamp as stale when the gate is ON", () => {
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const result = evaluateTradeProposal(buyProposal, ctx(policy, scanWith(undefined, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes("staleness_gate") && r.includes("missing"))).toBe(true);
  });

  it("allows a missing quote timestamp when the gate is OFF", () => {
    // maxQuoteAgeSec pinned 0 (defaults to 120 since the 2026-07-28 guard enablement).
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 0 };
    const result = evaluateTradeProposal(buyProposal, ctx(policy, scanWith(undefined, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
  });

  it("treats an unparseable asOf as stale when the gate is ON", () => {
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const result = evaluateTradeProposal(buyProposal, ctx(policy, scanWith("not-a-date", FRESH_GENERATED_AT)));
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes("staleness_gate") && r.includes("missing/unparseable"))).toBe(true);
  });

  it("blocks on stale fundamentals (scan generatedAt) older than maxFundamentalsAgeSec", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString(); // quote is fresh
    const staleGeneratedAt = new Date(NOW.getTime() - 7_200_000).toISOString(); // 7200s ago
    const policy: TradingPolicy = { ...basePolicy, maxFundamentalsAgeSec: 3600 };
    const result = evaluateTradeProposal(buyProposal, ctx(policy, scanWith(freshAsOf, staleGeneratedAt)));
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes("staleness_gate") && r.includes("market scan is"))).toBe(true);
  });

  it("never blocks a risk-reducing SELL even with very stale data and the gate ON", () => {
    const veryStaleAsOf = new Date(NOW.getTime() - 86_400_000).toISOString();
    const veryStaleGeneratedAt = new Date(NOW.getTime() - 86_400_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60, maxFundamentalsAgeSec: 60 };
    const result = evaluateTradeProposal(sellProposal, ctx(policy, scanWith(veryStaleAsOf, veryStaleGeneratedAt)));
    // Don't assert overall approved (sell may trip unrelated checks) — assert no staleness reason
    expect(result.reasons.every((r) => !r.includes("staleness_gate"))).toBe(true);
  });
});

describe("staleness gate — DEFAULT 120s (guard enablement 2026-07-28)", () => {
  // basePolicy spreads DEFAULT_POLICY with NO explicit maxQuoteAgeSec, so these exercise the new
  // owner-approved default threshold (120s) exactly as a default policy would see it.
  it("blocks an opening buy on a 300s-old quote under the default 120s gate", () => {
    const staleAsOf = new Date(NOW.getTime() - 300_000).toISOString(); // 300s ago
    const result = evaluateTradeProposal(buyProposal, ctx(basePolicy, scanWith(staleAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(false);
    expect(result.reasons.some((r) => r.includes("staleness_gate") && r.includes("max 120"))).toBe(true);
  });

  it("allows an opening buy on a 10s-old quote under the default 120s gate", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString(); // 10s ago
    const result = evaluateTradeProposal(buyProposal, ctx(basePolicy, scanWith(freshAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
  });

  it("allows a quote exactly at the 120s default boundary (strictly-greater check)", () => {
    const exactAsOf = new Date(NOW.getTime() - 120_000).toISOString(); // exactly 120s ago
    const result = evaluateTradeProposal(buyProposal, ctx(basePolicy, scanWith(exactAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
  });

  it("never gates a risk-reducing SELL under the default 120s gate", () => {
    const staleAsOf = new Date(NOW.getTime() - 300_000).toISOString();
    const result = evaluateTradeProposal(sellProposal, ctx(basePolicy, scanWith(staleAsOf, FRESH_GENERATED_AT)));
    expect(result.reasons.every((r) => !r.includes("staleness_gate"))).toBe(true);
  });
});
