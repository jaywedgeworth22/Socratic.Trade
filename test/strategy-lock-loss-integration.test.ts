import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const lockGuardMocks = vi.hoisted(() => ({
  assertOwned: vi.fn(),
  stop: vi.fn()
}));
const brokerMocks = vi.hoisted(() => ({
  placeEquityOrder: vi.fn()
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
    scanMarket: async (): Promise<import("../src/lib/types").MarketScan> => {
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

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-strategy-lock-loss-${randomUUID()}.db`)}`;
});

afterEach(() => {
  lockGuardMocks.assertOwned.mockReset();
  lockGuardMocks.stop.mockReset();
  brokerMocks.placeEquityOrder.mockReset();
  vi.restoreAllMocks();
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
});
