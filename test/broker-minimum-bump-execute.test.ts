/**
 * Integration tests for broker-minimum BUMP-TO-FLOOR on the approval path (executeProposal):
 * owner ruling 2026-07-09 — a below-minimum order is resized UP to the broker floor (default
 * brokerMinimumHandling "bump") instead of skipped, is re-reviewed exactly once, and then runs the
 * FULL policy gate at its bumped size, so caps still bind. These tests drive the REAL
 * executeProposal flow through a mocked BrokerGateway (activeBroker "robinhood", $1 floor) and
 * pin the wiring the unit suite can't see: the audit record, the proposal rebinding before
 * placement, the still-blocked one-shot fallback, cap enforcement at the bumped size, and the
 * "skip" off-switch.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { MarketQuote, MarketScan, ReviewedOrder } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Stub ONLY scanMarket (same rationale as order-confirmation-status.test.ts): left real it fans
// out to live Nasdaq/Yahoo fetches with multi-second abort timeouts and flakes the suite.
vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<MarketScan> => {
      const asOf = new Date().toISOString();
      const aapl: MarketQuote = {
        symbol: "AAPL",
        price: 200,
        bid: 199,
        ask: 200,
        volume: 1_000_000,
        intradayChangePct: 0,
        positionMarketValue: 0,
        score: 1,
        provider: "test-scan",
        asOf
      };
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: [aapl],
        sectorBySymbol: {},
        quotesBySymbol: { AAPL: aapl },
        warnings: []
      };
    }
  };
});

const ACCOUNT = "RH-BUMP-TEST";

// Gateway mock with full control of reviewEquityOrder — the bump math derives everything from the
// review's estimatedNotional, so echoing dollarAmount back as the estimate makes it exact.
const reviewEquityOrder = vi.fn();
const placeEquityOrder = vi.fn();
function makeGateway() {
  return {
    getAccounts: async () => [{ accountNumber: ACCOUNT, type: "brokerage" }],
    getPortfolio: async () => ({
      accountNumber: ACCOUNT,
      totalMarketValue: 5000,
      buyingPower: 2500,
      equityMarketValue: 5000,
      optionMarketValue: 0,
      cash: 2500
    }),
    getEquityPositions: async () => [],
    getEquityOrders: async () => [],
    getEquityQuotes: async () => ({ AAPL: { bid: 199, ask: 200, asOf: new Date().toISOString() } }),
    getEquityTradability: async (_acc: string, symbols: string[]) =>
      Object.fromEntries(symbols.map((s) => [s, { tradable: true, fractional: true }])),
    reviewEquityOrder,
    placeEquityOrder,
    cancelEquityOrder: async () => ({ ok: true })
  };
}

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return { ...actual, getBrokerGateway: () => makeGateway() };
});

function echoReview(input: { dollarAmount?: number; quantity?: number }): ReviewedOrder {
  return { estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 200, alerts: [], raw: {} };
}

async function seedApprovedProposal(userId: string, policyOverrides: Record<string, unknown> = {}): Promise<string> {
  const { upsertConnectedAccount, setPolicy, insertProposal } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-bump-test",
    userId,
    broker: "robinhood",
    environment: "paper", // identical placeEquityOrder path without the typed live-confirmation gate
    accountNumber: ACCOUNT,
    isActive: true,
    label: "Robinhood Bump Test"
  });
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: "acc-bump-test",
      activeBroker: "robinhood",
      systemState: "active",
      maxDailyNotional: 5_000,
      maxOrderNotional: 100,
      ...policyOverrides
    },
    userId
  );
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: ACCOUNT,
    userId,
    proposal: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      dollarAmount: 0.25, // below Robinhood's $1 floor
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "bump-to-floor integration test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  reviewEquityOrder.mockReset();
  placeEquityOrder.mockReset();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-broker-min-bump-${randomUUID()}.db`)}`;
});

describe("executeProposal — broker-minimum bump-to-floor wiring", () => {
  it("bumps a below-minimum dollar buy to the $1 floor, re-reviews once, places at the bumped size, and audits it", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));
    placeEquityOrder.mockImplementation(async (i) => ({ id: `ord-${randomUUID()}`, state: "confirmed", raw: {}, ...i }));

    const userId = `bump-happy-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listAudit } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);

    expect(result.status).toBe("placed");
    // Exactly two reviews: original ($0.25) then the bumped order ($1, quantity cleared).
    expect(reviewEquityOrder).toHaveBeenCalledTimes(2);
    expect(reviewEquityOrder.mock.calls[1][0]).toMatchObject({ dollarAmount: 1 });
    expect(reviewEquityOrder.mock.calls[1][0].quantity).toBeUndefined();
    // Placement went out at the bumped size, not the original.
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    expect(placeEquityOrder.mock.calls[0][0]).toMatchObject({ dollarAmount: 1 });
    // Audit trail records original -> bumped.
    const bumpEvents = listAudit(50, userId).filter((e) => e.kind === "order_bumped_to_broker_minimum");
    expect(bumpEvents.length).toBe(1);
    const detail = bumpEvents[0].payload as Record<string, unknown>;
    expect(detail.originalDollarAmount).toBe(0.25);
    expect(detail.bumpedDollarAmount).toBe(1);
    expect(detail.action).toBe("approval");
    // The stored row's proposal JSON reflects the EXECUTED (bumped) sizing — crash-recovery books
    // fills from this JSON, so it must match what was actually sent to the broker.
    const row = getProposal(proposalId, userId);
    expect(row?.proposal?.dollarAmount).toBe(1);
  });

  it("caps still bind at the bumped size — a bump that violates a policy cap is blocked, never placed", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));

    const userId = `bump-cap-${randomUUID()}`;
    // Per-order cap $0.50: the $1 bumped order must be blocked by the NORMAL policy engine.
    const proposalId = await seedApprovedProposal(userId, { maxOrderNotional: 0.5 });
    const { executeProposal } = await import("../src/lib/strategy");

    const result = await executeProposal(proposalId, userId);

    expect(result.status).toBe("blocked");
    expect(placeEquityOrder).not.toHaveBeenCalled();
  });

  it("one-shot fallback: if the broker still flags the bumped order, it takes the block path (no loop)", async () => {
    reviewEquityOrder.mockImplementation(async (i) => ({
      ...echoReview(i),
      preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "still too small" }
    }));

    const userId = `bump-stillblocked-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listAudit } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);

    expect(result.status).toBe("blocked");
    // Original review + exactly ONE bump re-review — never a loop.
    expect(reviewEquityOrder).toHaveBeenCalledTimes(2);
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(getProposal(proposalId, userId)?.status).toBe("blocked");
    const skips = listAudit(50, userId).filter((e) => e.kind === "order_skipped_broker_minimum");
    expect(skips.length).toBe(1);
  });

  it('the "skip" off-switch restores pre-ruling behavior: blocked without any bump attempt', async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));

    const userId = `bump-skip-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId, { brokerMinimumHandling: "skip" });
    const { executeProposal } = await import("../src/lib/strategy");

    const result = await executeProposal(proposalId, userId);

    expect(result.status).toBe("blocked");
    expect(reviewEquityOrder).toHaveBeenCalledTimes(1); // no bump re-review
    expect(placeEquityOrder).not.toHaveBeenCalled();
  });
});
