/**
 * Inline placement-error reconciliation (the "always uncertain" fix). When placeEquityOrder THROWS,
 * we no longer immediately fire a perpetual "verify with broker" alert — we ask the broker (via the
 * refId idempotency key) what actually happened and map to a DEFINITE status where we can:
 *   - order present + live/filled → "placed" (recovered), fill booked, NO uncertain alert
 *   - order present + declined    → "rejected_by_broker"
 *   - order absent                → "not_placed" (safe to retry)
 *   - broker unreachable          → stays "placing" + the (protected) "verify with broker" alert
 *
 * Driven end-to-end through the REAL executeProposal (approval path) with a mocked BrokerGateway
 * whose placeEquityOrder throws and whose post-placement getEquityOrders is scripted per case.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { EquityOrder, MarketQuote, MarketScan, ReviewedOrder } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Stub ONLY scanMarket so approval reconcile doesn't fan out to live fetches (same rationale as the
// broker-minimum-bump-execute suite).
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

const ACCOUNT = "RECONCILE-TEST";

// Scriptable gateway: placeEquityOrder captures the internally-generated refId and throws;
// getEquityOrders returns [] BEFORE placement (so any pre-placement poll is inert) and the scripted
// post-placement result afterwards (or throws to simulate an unreachable broker).
let capturedRefId = "";
let placementAttempted = false;
let postPlacementOrders: EquityOrder[] = [];
let getEquityOrdersThrowsAfterPlacement = false;
// Whether the mocked broker's order list is authoritative for recently-terminal orders. Default
// true (Alpaca-like) so "order ABSENT → not_placed" exercises the safe-to-retry path; the
// conservative case (Robinhood-like, terminal inclusion unverified) sets it false so an absent order
// stays 'placing' + uncertain instead of being wrongly declared not_placed.
let authoritativeOrderList = true;

const placeImpl = async (input: { refId: string }) => {
  capturedRefId = input.refId;
  placementAttempted = true;
  throw new Error("network timeout during placement");
};
const getOrdersImpl = async (): Promise<EquityOrder[]> => {
  if (!placementAttempted) return [];
  if (getEquityOrdersThrowsAfterPlacement) throw new Error("broker unreachable");
  return postPlacementOrders;
};
const placeEquityOrder = vi.fn(placeImpl);
const getEquityOrders = vi.fn(getOrdersImpl);

function echoReview(input: { dollarAmount?: number; quantity?: number }): ReviewedOrder {
  return { estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 200, alerts: [], raw: {} };
}

function makeGateway() {
  return {
    ordersListIncludesTerminal: authoritativeOrderList,
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
    getEquityOrders,
    getEquityQuotes: async () => ({ AAPL: { bid: 199, ask: 200, asOf: new Date().toISOString() } }),
    getEquityTradability: async (_acc: string, symbols: string[]) =>
      Object.fromEntries(symbols.map((s) => [s, { tradable: true, fractional: true }])),
    reviewEquityOrder: vi.fn(async (i) => echoReview(i)),
    placeEquityOrder,
    cancelEquityOrder: async () => ({ ok: true })
  };
}

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return { ...actual, getBrokerGateway: () => makeGateway() };
});

async function seedApprovedProposal(userId: string): Promise<string> {
  const { upsertConnectedAccount, setPolicy, insertProposal } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-reconcile-test",
    userId,
    broker: "robinhood",
    environment: "paper",
    accountNumber: ACCOUNT,
    isActive: true,
    label: "Reconcile Test"
  });
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: "acc-reconcile-test",
      activeBroker: "robinhood",
      systemState: "active",
      maxDailyNotional: 50_000,
      maxOrderNotional: 10_000
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
      quantity: 1, // 1 @ ~$200 stays under the NAV-derived $250 per-order / 25% position caps
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "reconcile integration test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)",
      referencePrice: 200
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  capturedRefId = "";
  placementAttempted = false;
  postPlacementOrders = [];
  getEquityOrdersThrowsAfterPlacement = false;
  authoritativeOrderList = true;
  placeEquityOrder.mockReset();
  placeEquityOrder.mockImplementation(placeImpl);
  getEquityOrders.mockReset();
  getEquityOrders.mockImplementation(getOrdersImpl);
  // Deterministic booked price for the recovered fill (the paper cost model would nudge it).
  process.env.PAPER_EXECUTION_COST_MODEL = "off";
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-placement-reconcile-${randomUUID()}.db`)}`;
});

function brokerOrder(over: Partial<EquityOrder>): EquityOrder {
  return {
    id: `ord-${randomUUID()}`,
    symbol: "AAPL",
    side: "buy",
    type: "market",
    state: "accepted",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  };
}

describe("inline placement-error reconciliation via executeProposal", () => {
  it("throw + order PRESENT (live) → placed, fill pending_reconciliation, NO uncertain alert", async () => {
    const userId = `reco-live-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    postPlacementOrders = []; // set below once we know the captured refId is used at reconcile time
    // getEquityOrders reads postPlacementOrders lazily at call time; script it to echo the captured
    // refId by using a getter-like closure: replace the array right before executeProposal reconciles.
    getEquityOrders.mockImplementation(async () => {
      if (!placementAttempted) return [];
      return [brokerOrder({ clientOrderId: capturedRefId, state: "accepted" })];
    });

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listFillEventsByProposalId, listNotificationEvents } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);
    expect(result.status).toBe("placed");

    expect(getProposal(proposalId, userId)?.status).toBe("placed");
    const fills = listFillEventsByProposalId(proposalId, userId);
    expect(fills.length).toBe(1);
    expect(fills[0].status).toBe("pending_reconciliation");

    const notifs = listNotificationEvents(userId);
    expect(notifs.some((n) => n.type === "run_failed" && (n.payload as Record<string, unknown>).reconcile === "uncertain")).toBe(false);
    expect(notifs.some((n) => n.type === "fill" && (n.payload as Record<string, unknown>).reconcile === "recovered")).toBe(true);
  });

  it("throw + order PRESENT (filled) → placed, fill status filled at broker price/qty", async () => {
    const userId = `reco-filled-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    getEquityOrders.mockImplementation(async () => {
      if (!placementAttempted) return [];
      return [brokerOrder({ clientOrderId: capturedRefId, state: "filled", filledQuantity: 1, averagePrice: 201.5 })];
    });

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listFillEventsByProposalId } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);
    expect(result.status).toBe("filled");
    expect(getProposal(proposalId, userId)?.status).toBe("filled");
    const fills = listFillEventsByProposalId(proposalId, userId);
    expect(fills.length).toBe(1);
    expect(fills[0].status).toBe("filled");
    expect(fills[0].quantity).toBe(1);
    expect(fills[0].price).toBe(201.5);
  });

  it("throw + order PRESENT (declined) → rejected_by_broker, decline alert, NO fill", async () => {
    const userId = `reco-declined-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    getEquityOrders.mockImplementation(async () => {
      if (!placementAttempted) return [];
      return [brokerOrder({ clientOrderId: capturedRefId, state: "rejected" })];
    });

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listFillEventsByProposalId, listNotificationEvents } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);
    expect(result.status).toBe("error");
    expect(getProposal(proposalId, userId)?.status).toBe("rejected_by_broker");
    expect(listFillEventsByProposalId(proposalId, userId).length).toBe(0);

    const notifs = listNotificationEvents(userId);
    const declined = notifs.find((n) => n.type === "run_failed" && (n.payload as Record<string, unknown>).reconcile === "declined");
    expect(declined).toBeTruthy();
    expect(declined?.title).toContain("declined by broker");
  });

  it("throw + order ABSENT → not_placed (safe to retry), NO fill, alert is sweepable", async () => {
    const userId = `reco-absent-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    getEquityOrders.mockImplementation(async () => {
      if (!placementAttempted) return [];
      // An unrelated order with a DIFFERENT clientOrderId must never false-match.
      return [brokerOrder({ clientOrderId: "some-other-key", state: "accepted" })];
    });

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listFillEventsByProposalId, listNotificationEvents } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);
    expect(result.status).toBe("not_placed");
    expect(getProposal(proposalId, userId)?.status).toBe("not_placed");
    expect(listFillEventsByProposalId(proposalId, userId).length).toBe(0);

    const notifs = listNotificationEvents(userId);
    const np = notifs.find((n) => n.type === "run_failed" && (n.payload as Record<string, unknown>).reconcile === "not_placed");
    expect(np).toBeTruthy();
    expect(np?.title).toContain("was NOT placed");
  });

  it("throw + order ABSENT + NON-authoritative list (Robinhood) → uncertain, stays 'placing', NOT not_placed", async () => {
    // (3) The conservative-broker guard: when the gateway can't guarantee its order list includes
    // recently-terminal orders (ordersListIncludesTerminal falsey), an absent order must NOT be
    // declared not_placed — a placed-then-filled order that aged out would be dropped and duplicated.
    // It must stay 'placing' + the protected uncertain alert instead.
    authoritativeOrderList = false;
    const userId = `reco-absent-conservative-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    getEquityOrders.mockImplementation(async () => {
      if (!placementAttempted) return [];
      // Order genuinely absent from a list that may omit terminal orders.
      return [brokerOrder({ clientOrderId: "some-other-key", state: "accepted" })];
    });

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listFillEventsByProposalId, listNotificationEvents } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);
    expect(result.status).toBe("error");
    // Must stay 'placing' (the ONLY durable-intent state) — never not_placed for a non-authoritative broker.
    expect(getProposal(proposalId, userId)?.status).toBe("placing");
    expect(listFillEventsByProposalId(proposalId, userId).length).toBe(0);

    const notifs = listNotificationEvents(userId);
    expect(notifs.some((n) => n.type === "run_failed" && (n.payload as Record<string, unknown>).reconcile === "not_placed")).toBe(false);
    const uncertain = notifs.find((n) => n.type === "run_failed" && (n.payload as Record<string, unknown>).reconcile === "uncertain");
    expect(uncertain).toBeTruthy();
    expect(uncertain?.title).toContain("verify with broker");
  });

  it("throw + broker UNREACHABLE → stays 'placing' + protected uncertain alert, NO fill", async () => {
    const userId = `reco-unreachable-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    getEquityOrdersThrowsAfterPlacement = true;

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listFillEventsByProposalId, listNotificationEvents } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);
    expect(result.status).toBe("error");
    // The (3) regression guard: the row must remain 'placing' (NOT 'placing_failed') so the sweep
    // can finish it — this is the ONLY branch that leaves a durable intent.
    expect(getProposal(proposalId, userId)?.status).toBe("placing");
    expect(listFillEventsByProposalId(proposalId, userId).length).toBe(0);

    const notifs = listNotificationEvents(userId);
    const uncertain = notifs.find((n) => n.type === "run_failed" && (n.payload as Record<string, unknown>).reconcile === "uncertain");
    expect(uncertain).toBeTruthy();
    expect(uncertain?.title).toContain("verify with broker");
  });
});
