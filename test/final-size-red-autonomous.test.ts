import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway, MarketQuote, MarketScan } from "../src/lib/types";

const { debateProposal, reviewEquityOrder, placeEquityOrder, rationaleDiversityState, brokerFailureState } = vi.hoisted(() => ({
  debateProposal: vi.fn(),
  reviewEquityOrder: vi.fn(),
  placeEquityOrder: vi.fn(),
  rationaleDiversityState: { collapsed: false },
  brokerFailureState: { placementAttempted: false, ordersUnreachable: false }
}));

vi.mock("../src/lib/red-team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/red-team")>();
  return { ...actual, debateProposal };
});

vi.mock("../src/lib/rationale-diversity", () => ({
  computeRationaleDiversity: (rationales: string[]) => ({
    count: rationales.length,
    meanPairwiseSimilarity: rationaleDiversityState.collapsed ? 0.99 : 0,
    maxPairwiseSimilarity: rationaleDiversityState.collapsed ? 0.99 : 0,
    collapsed: rationaleDiversityState.collapsed,
    threshold: 0.85
  })
}));

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<MarketScan> => {
      const asOf = new Date().toISOString();
      const quote: MarketQuote = {
        symbol: "AAPL",
        price: 10,
        bid: 9.99,
        ask: 10,
        volume: 1_000_000,
        intradayChangePct: 0.5,
        positionMarketValue: 0,
        score: 80,
        provider: "test-scan",
        asOf
      };
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: [quote],
        sectorBySymbol: { AAPL: "Technology" },
        quotesBySymbol: { AAPL: quote },
        warnings: []
      };
    }
  };
});

const ACCOUNT = "RH-AUTONOMOUS-FINAL-SIZE";

function gateway(): BrokerGateway {
  return {
    getAccounts: async () => [{ accountNumber: ACCOUNT, label: "Autonomous final-size test", agenticAllowed: true }],
    getPortfolio: async () => ({
      accountNumber: ACCOUNT,
      totalMarketValue: 100,
      buyingPower: 100,
      equityMarketValue: 0,
      optionMarketValue: 0,
      cash: 100
    }),
    getEquityPositions: async () => [],
    getEquityOrders: async () => {
      if (brokerFailureState.placementAttempted && brokerFailureState.ordersUnreachable) {
        throw new Error("broker unreachable after placement timeout");
      }
      return [];
    },
    getEquityQuotes: async () => ({ AAPL: { symbol: "AAPL", bid: 9.99, ask: 10, asOf: new Date().toISOString() } }),
    getEquityTradability: async (_account, symbols) =>
      Object.fromEntries(symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])),
    reviewEquityOrder,
    placeEquityOrder,
    cancelEquityOrder: async () => ({ orderId: randomUUID(), refId: randomUUID(), state: "cancelled", raw: {} })
  };
}

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return { ...actual, getBrokerGateway: () => gateway() };
});

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-final-size-autonomous-${randomUUID()}.db`)}`;
  debateProposal.mockReset();
  reviewEquityOrder.mockReset();
  placeEquityOrder.mockReset();
  rationaleDiversityState.collapsed = false;
  brokerFailureState.placementAttempted = false;
  brokerFailureState.ordersUnreachable = false;
});

function stubGreenProposalResponse(): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    if (String(url).includes("api.openai.com")) {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            proposals: [
              {
                symbol: "AAPL",
                side: "buy",
                type: "market",
                dollarAmount: 0.25,
                timeInForce: "gfd",
                marketHours: "regular_hours",
                rationale: "Small-account value setup.",
                tradeThesisTag: "Value-Quality",
                entryMarketRegime: "Neutral (Normal Volatility)",
                confidenceScore: 75
              }
            ]
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}

async function configureAutonomousAccount(userId: string, gateOnRationaleCollapse: boolean = false): Promise<void> {
  const { setPolicy, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "autonomous-final-size-account",
    userId,
    broker: "robinhood",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "Autonomous final-size account",
    isActive: true
  });
  upsertUserApiKey(userId, "openai", "test-openai-key", "test fixture");
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: "autonomous-final-size-account",
      activeBroker: "robinhood",
      systemState: "active",
      strategyAuthority: "decide",
      llmModel: "gpt-4.1-mini",
      redTeamLlmModel: "gpt-5.6-terra",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      tuning: { ...DEFAULT_POLICY.tuning, gateOnRationaleCollapse }
    },
    userId
  );
}

describe("autonomous broker-minimum final-size Red review", () => {
  it("reruns Red on the broker-reviewed order, persists the new rejection, and routes to approval without placement", async () => {
    debateProposal
      .mockResolvedValueOnce({
        verdict: "approve",
        rejected: false,
        available: true,
        reason: "Initial finalized size is acceptable.",
        model: "gpt-5.6-terra"
      })
      .mockResolvedValueOnce({
        verdict: "reject",
        rejected: true,
        available: true,
        reason: "The broker-adjusted order is not justified.",
        model: "gpt-5.6-terra"
      });
    reviewEquityOrder
      .mockResolvedValueOnce({
        estimatedNotional: 0.25,
        alerts: [],
        preflightBlock: {
          alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"],
          message: "below broker minimum"
        },
        raw: {}
      })
      .mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
        estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
        alerts: [],
        raw: {}
      }));
    placeEquityOrder.mockResolvedValue({ orderId: randomUUID(), refId: randomUUID(), state: "filled", raw: {} });

    stubGreenProposalResponse();

    const userId = `autonomous-final-size-${randomUUID()}`;
    await configureAutonomousAccount(userId);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listRecentProposals } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(debateProposal).toHaveBeenCalledTimes(2);
    const finalReviewInput = debateProposal.mock.calls[1][0];
    expect(finalReviewInput.rationale).toBe("Small-account value setup.");
    expect(finalReviewInput.redTeamVerdict).toBeUndefined();
    expect(debateProposal.mock.calls[1][4]?.sizing).toMatchObject({ estimatedNotional: 1, estimatedPctOfNav: 1 });
    expect(placeEquityOrder).not.toHaveBeenCalled();

    const row = listRecentProposals(ACCOUNT, 20, userId).find((candidate) => candidate.proposal.symbol === "AAPL");
    expect(row?.status).toBe("proposed");
    expect(row?.proposal.redTeamVerdict).toMatchObject({
      verdict: "reject",
      rejected: true,
      reason: "The broker-adjusted order is not justified."
    });
    expect(row?.proposal.finalSizeReview).toMatchObject({
      trigger: "broker_minimum_bump",
      fromNotional: 0.25,
      toNotional: 1,
      ownerApprovalRequired: true
    });
    expect(row?.proposal.sizingSnapshot).toMatchObject({ estimatedNotional: 1, estimatedPctOfNav: 1 });
    expect(listAudit(100, userId).filter((event) => event.kind === "red_team_rereview_after_broker_minimum")).toHaveLength(1);
  }, 30_000);

  it("persists proposal intent and its Socratic case atomically before broker submission, then places after final-size approval", async () => {
    debateProposal
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Initial size approved.", model: "gpt-5.6-terra" })
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Broker-adjusted size approved.", model: "gpt-5.6-terra" });
    reviewEquityOrder
      .mockResolvedValueOnce({
        estimatedNotional: 0.25,
        alerts: [],
        preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "below broker minimum" },
        raw: {}
      })
      .mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
        estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
        alerts: [],
        raw: {}
      }));
    stubGreenProposalResponse();
    const userId = `autonomous-final-size-place-${randomUUID()}`;
    await configureAutonomousAccount(userId);
    placeEquityOrder.mockImplementation(async () => {
      const { listRecentProposals, listSocraticDecisionCases } = await import("../src/lib/db");
      expect(listRecentProposals(ACCOUNT, 10, userId)[0]?.status).toBe("placing");
      expect(listSocraticDecisionCases(userId, { connectedAccountId: "autonomous-final-size-account" })[0]?.status).toBe("placing");
      return { orderId: randomUUID(), refId: randomUUID(), state: "filled", raw: {} };
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals, listSocraticDecisionCases } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    expect(listRecentProposals(ACCOUNT, 10, userId)[0]).toMatchObject({ status: "filled", estimatedNotional: 1 });
    expect(listSocraticDecisionCases(userId, { connectedAccountId: "autonomous-final-size-account" })[0]).toMatchObject({ status: "filled", notional: 1 });
  }, 30_000);

  it("does not clear an independent rationale-collapse hold when final-size Red approves", async () => {
    rationaleDiversityState.collapsed = true;
    debateProposal
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Initial size approved.", model: "gpt-5.6-terra" })
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Broker-adjusted size approved.", model: "gpt-5.6-terra" });
    reviewEquityOrder
      .mockResolvedValueOnce({
        estimatedNotional: 0.25,
        alerts: [],
        preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "below broker minimum" },
        raw: {}
      })
      .mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
        estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
        alerts: [],
        raw: {}
      }));
    stubGreenProposalResponse();
    const userId = `autonomous-final-size-held-${randomUUID()}`;
    await configureAutonomousAccount(userId, true);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listNotificationEvents, listRecentProposals, listSocraticDecisionCases } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    const row = listRecentProposals(ACCOUNT, 10, userId)[0];
    expect(row?.status).toBe("proposed");
    expect(row?.proposal.finalSizeReview).toMatchObject({ ownerApprovalRequired: false, toNotional: 1 });
    expect(row?.proposal.rationale).toContain("Rationale-diversity gate");
    expect(row?.proposal.humanReviewReasons).toEqual([
      expect.objectContaining({ code: "rationale_collapse", title: "Rationale-diversity hold" })
    ]);
    expect(result.proposals[0]?.reasons.join(" ")).toContain("Rationale-diversity hold");
    expect(result.proposals[0]?.reasons.join(" ")).not.toContain("Red Team review unavailable");
    expect(listNotificationEvents(userId).find((event) => event.type === "pending_approval")?.title).toContain("Rationale-diversity hold");
    expect(listSocraticDecisionCases(userId, { connectedAccountId: "autonomous-final-size-account" })[0]).toMatchObject({ status: "proposed" });
  }, 30_000);

  it("keeps both proposal and Socratic case in placing when autonomous broker acceptance is uncertain", async () => {
    debateProposal
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Initial size approved.", model: "gpt-5.6-terra" })
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Broker-adjusted size approved.", model: "gpt-5.6-terra" });
    reviewEquityOrder
      .mockResolvedValueOnce({
        estimatedNotional: 0.25,
        alerts: [],
        preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "below broker minimum" },
        raw: {}
      })
      .mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
        estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
        alerts: [],
        raw: {}
      }));
    brokerFailureState.ordersUnreachable = true;
    placeEquityOrder.mockImplementation(async () => {
      brokerFailureState.placementAttempted = true;
      throw new Error("network timeout during placement");
    });
    stubGreenProposalResponse();
    const userId = `autonomous-uncertain-${randomUUID()}`;
    await configureAutonomousAccount(userId);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals, listSocraticDecisionCases } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(listRecentProposals(ACCOUNT, 10, userId)[0]?.status).toBe("placing");
    const decisionCase = listSocraticDecisionCases(userId, { connectedAccountId: "autonomous-final-size-account" })[0];
    expect(decisionCase?.status).toBe("placing");
    expect(decisionCase?.evidence[0]).toMatchObject({ title: "Placement pending confirmation" });
    expect(decisionCase?.evidence[0]?.summary).toContain("network timeout during placement");
    expect(decisionCase?.evidence[0]?.title).not.toBe("Policy approved");
  }, 30_000);
});
