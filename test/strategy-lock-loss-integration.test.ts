import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const lockGuardMocks = vi.hoisted(() => ({
  assertOwned: vi.fn(),
  stop: vi.fn()
}));
const brokerMocks = vi.hoisted(() => ({
  getAccounts: vi.fn(),
  getEquityTradability: vi.fn(),
  reviewEquityOrder: vi.fn(),
  placeEquityOrder: vi.fn()
}));
const marketMocks = vi.hoisted(() => ({
  scanMarket: vi.fn()
}));

vi.mock("../src/lib/strategy-lock-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy-lock-guard")>();
  return {
    ...actual,
    startStrategyLockGuard: () => ({
      assertOwned: lockGuardMocks.assertOwned,
      stop: lockGuardMocks.stop
    })
  };
});

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: (...args: Parameters<typeof actual.getBrokerGateway>) => {
      const gateway = actual.getBrokerGateway(...args);
      return new Proxy(gateway, {
        get(target, property, receiver) {
          if (property === "getAccounts" && brokerMocks.getAccounts.getMockImplementation()) {
            return brokerMocks.getAccounts;
          }
          if (property === "getEquityTradability" && brokerMocks.getEquityTradability.getMockImplementation()) {
            return brokerMocks.getEquityTradability;
          }
          if (property === "reviewEquityOrder" && brokerMocks.reviewEquityOrder.getMockImplementation()) {
            return brokerMocks.reviewEquityOrder;
          }
          if (property === "placeEquityOrder") return brokerMocks.placeEquityOrder;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  };
});

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: marketMocks.scanMarket
  };
});

import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  acquireStrategyLock,
  getProposal,
  insertProposal,
  releaseStrategyLock,
  setActiveConnectedAccount,
  setPolicy,
  upsertConnectedAccount
} from "../src/lib/db";
import { executeProposal } from "../src/lib/strategy-execution";
import { StrategyLockOwnershipLostError } from "../src/lib/strategy-lock-guard";

const ACCOUNT = "ACC-LOCK-LOSS";

function strategyMarketScan(): import("../src/lib/types").MarketScan {
  const asOf = new Date().toISOString();
  const quote: import("../src/lib/types").MarketQuote = {
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
    topCandidates: [quote],
    sectorBySymbol: {},
    quotesBySymbol: { AAPL: quote },
    warnings: []
  };
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-strategy-lock-loss-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  marketMocks.scanMarket.mockReset().mockImplementation(async () => strategyMarketScan());
});

afterEach(() => {
  lockGuardMocks.assertOwned.mockReset();
  lockGuardMocks.stop.mockReset();
  brokerMocks.getAccounts.mockReset();
  brokerMocks.getEquityTradability.mockReset();
  brokerMocks.reviewEquityOrder.mockReset();
  brokerMocks.placeEquityOrder.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function arrangeProposedOrder(userId: string): { accountId: string; proposalId: string } {
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "test",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "Lease-loss test account",
    isActive: true
  });
  setActiveConnectedAccount(accountId, userId);
  setPolicy({ ...DEFAULT_POLICY, accountNumber: ACCOUNT, systemState: "active" }, userId);

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
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "lease ownership integration test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return { accountId, proposalId };
}

describe("approval execution ownership loss", () => {
  it("returns busy, leaves the proposal pending, and never calls the broker", async () => {
    const userId = `lease-loss-${randomUUID()}`;
    const { accountId, proposalId } = arrangeProposedOrder(userId);
    lockGuardMocks.assertOwned.mockImplementation(() => {
      throw new StrategyLockOwnershipLostError();
    });

    const result = await executeProposal(proposalId, userId);

    expect(result).toMatchObject({
      status: "busy",
      reasons: [expect.stringMatching(/ownership was lost/i)]
    });
    expect(brokerMocks.placeEquityOrder).not.toHaveBeenCalled();
    expect(getProposal(proposalId, userId)?.status).toBe("proposed");
    expect(lockGuardMocks.stop).toHaveBeenCalledTimes(1);
    expect(acquireStrategyLock("replacement-owner", userId, accountId)).toBe(true);
    releaseStrategyLock("replacement-owner", userId, accountId);
  }, 20_000);

  it("does not block the card when ownership is lost during approval tradability", async () => {
    const userId = `approval-tradability-loss-${randomUUID()}`;
    const { proposalId } = arrangeProposedOrder(userId);
    let ownershipLost = false;
    lockGuardMocks.assertOwned.mockImplementation(() => {
      if (ownershipLost) throw new StrategyLockOwnershipLostError();
    });
    brokerMocks.getEquityTradability.mockImplementation(async () => {
      ownershipLost = true;
      return { AAPL: { tradable: false, reason: "fixture block" } };
    });

    const result = await executeProposal(proposalId, userId);

    expect(result).toMatchObject({ status: "busy", reasons: [expect.stringMatching(/ownership was lost/i)] });
    expect(getProposal(proposalId, userId)?.status).toBe("proposed");
    expect(brokerMocks.reviewEquityOrder).not.toHaveBeenCalled();
    expect(brokerMocks.placeEquityOrder).not.toHaveBeenCalled();
  }, 20_000);

  it("does not re-evaluate or block the card when ownership is lost during approval review", async () => {
    const userId = `approval-review-loss-${randomUUID()}`;
    const { proposalId } = arrangeProposedOrder(userId);
    let ownershipLost = false;
    lockGuardMocks.assertOwned.mockImplementation(() => {
      if (ownershipLost) throw new StrategyLockOwnershipLostError();
    });
    brokerMocks.getEquityTradability.mockResolvedValue({ AAPL: { tradable: true, fractional: true } });
    brokerMocks.reviewEquityOrder.mockImplementation(async () => {
      ownershipLost = true;
      return { estimatedNotional: 500, alerts: [], raw: {} };
    });

    const result = await executeProposal(proposalId, userId);

    expect(result).toMatchObject({ status: "busy", reasons: [expect.stringMatching(/ownership was lost/i)] });
    expect(getProposal(proposalId, userId)?.status).toBe("proposed");
    expect(brokerMocks.placeEquityOrder).not.toHaveBeenCalled();
  }, 20_000);
});

const STRATEGY_ACCOUNT = "TEST";
const STRATEGY_PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 100,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "lease ownership non-placement test",
  tradeThesisTag: "Momentum-Breakout",
  entryMarketRegime: "Neutral (Normal Volatility)",
  confidenceScore: 90
};

async function arrangeStrategyRun(userId: string): Promise<string> {
  const db = await import("../src/lib/db");
  const accountId = randomUUID();
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "test",
    environment: "paper",
    accountNumber: STRATEGY_ACCOUNT,
    label: "Strategy lease-loss test account",
    isActive: true
  });
  db.setActiveConnectedAccount(accountId, userId);
  db.upsertUserApiKey(userId, "openai", "test-openai-key", "lease-loss fixture");
  db.setPolicy({
    ...DEFAULT_POLICY,
    connectedAccountId: accountId,
    accountNumber: STRATEGY_ACCOUNT,
    activeBroker: "test",
    systemState: "active",
    strategyAuthority: "propose",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    llmModel: "gpt-4.1-mini",
    redTeamLlmModel: "gpt-4.1-mini"
  }, userId);
  return accountId;
}

function stubStrategyLlm(): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("api.openai.com")) return new Response("not found", { status: 404 });
    const body = init?.body ? String(init.body) : "";
    if (body.includes("Red Team Risk Agent")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", reason: "No fatal flaw." }) } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [STRATEGY_PROPOSAL] }) }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
}

describe("strategy-run ownership loss across broker awaits", () => {
  it("stops before market scan and snapshots when ownership is lost during setup reads", async () => {
    const userId = `setup-read-loss-${randomUUID()}`;
    const accountId = await arrangeStrategyRun(userId);
    let ownershipLost = false;
    let accountReads = 0;
    lockGuardMocks.assertOwned.mockImplementation(() => {
      if (ownershipLost) throw new StrategyLockOwnershipLostError();
    });
    brokerMocks.getAccounts.mockImplementation(async () => {
      accountReads += 1;
      if (accountReads === 2) ownershipLost = true;
      return [{ accountNumber: STRATEGY_ACCOUNT, label: "Test broker", agenticAllowed: true }];
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce(userId, { manual: true, connectedAccountId: accountId });
    const db = await import("../src/lib/db");

    expect(result).toMatchObject({ status: "failed", proposals: [] });
    expect(result.summary).toMatch(/ownership was lost/i);
    expect(accountReads).toBe(2);
    expect(marketMocks.scanMarket).not.toHaveBeenCalled();
    expect(db.listRecentProposals(STRATEGY_ACCOUNT, 100, userId)).toEqual([]);
    expect(brokerMocks.placeEquityOrder).not.toHaveBeenCalled();
  }, 30_000);

  it("does not persist a blocked proposal when ownership is lost during tradability", async () => {
    const userId = `tradability-loss-${randomUUID()}`;
    const accountId = await arrangeStrategyRun(userId);
    stubStrategyLlm();
    let ownershipLost = false;
    lockGuardMocks.assertOwned.mockImplementation(() => {
      if (ownershipLost) throw new StrategyLockOwnershipLostError();
    });
    brokerMocks.getEquityTradability.mockImplementation(async () => {
      ownershipLost = true;
      return { AAPL: { tradable: false, reason: "fixture block" } };
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce(userId, { manual: true, connectedAccountId: accountId });
    const db = await import("../src/lib/db");

    expect(result).toMatchObject({ status: "failed", proposals: [] });
    expect(result.summary).toMatch(/ownership was lost/i);
    expect(db.listRecentProposals(STRATEGY_ACCOUNT, 100, userId)).toEqual([]);
    expect(brokerMocks.reviewEquityOrder).not.toHaveBeenCalled();
    expect(brokerMocks.placeEquityOrder).not.toHaveBeenCalled();
  }, 30_000);

  it("does not persist a proposed card when ownership is lost during broker review", async () => {
    const userId = `review-loss-${randomUUID()}`;
    const accountId = await arrangeStrategyRun(userId);
    stubStrategyLlm();
    let ownershipLost = false;
    lockGuardMocks.assertOwned.mockImplementation(() => {
      if (ownershipLost) throw new StrategyLockOwnershipLostError();
    });
    brokerMocks.getEquityTradability.mockResolvedValue({ AAPL: { tradable: true, fractional: true } });
    brokerMocks.reviewEquityOrder.mockImplementation(async () => {
      ownershipLost = true;
      return { estimatedNotional: 100, alerts: [], raw: {} };
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce(userId, { manual: true, connectedAccountId: accountId });
    const db = await import("../src/lib/db");

    expect(result).toMatchObject({ status: "failed", proposals: [] });
    expect(result.summary).toMatch(/ownership was lost/i);
    expect(db.listRecentProposals(STRATEGY_ACCOUNT, 100, userId)).toEqual([]);
    expect(brokerMocks.placeEquityOrder).not.toHaveBeenCalled();
  }, 30_000);
});
