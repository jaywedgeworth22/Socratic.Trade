import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { reconcilePendingFills, generateProactiveRiskProposals } from "../src/lib/strategy";
import { insertFillEvent, listFillEvents } from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { RobinhoodGateway } from "../src/lib/robinhood";
import type { EquityOrder, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-reconciliation-${randomUUID()}.db`)}`;
});

describe("reconcilePendingFills", () => {
  it("updates pending_reconciliation live fills when matched broker order is filled", async () => {
    const fillId = randomUUID();
    const brokerOrderId = "broker-order-123";
    insertFillEvent({
      id: fillId,
      proposalId: "p1",
      runId: "r1",
      accountNumber: "ACC123",
      source: "live",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 150,
      notional: 1500,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: { test: true }
    });

    const mockGateway = {
      getEquityOrders: async () => [
        {
          id: brokerOrderId,
          symbol: "AAPL",
          side: "buy",
          type: "market",
          state: "filled",
          filledQuantity: 10,
          averagePrice: 155,
          createdAt: new Date().toISOString(),
          updatedAt: "2026-06-15T12:00:00.000Z"
        } as EquityOrder
      ]
    } as unknown as RobinhoodGateway;

    await reconcilePendingFills(mockGateway, "ACC123");

    const fills = listFillEvents("ACC123", "live");
    const matched = fills.find((f) => f.id === fillId);
    expect(matched).toBeDefined();
    expect(matched!.status).toBe("filled");
    expect(matched!.price).toBe(155);
    expect(matched!.notional).toBe(1550);
  });

  it("updates status to cancelled/rejected when broker order fails", async () => {
    const fillId = randomUUID();
    const brokerOrderId = "broker-order-456";
    insertFillEvent({
      id: fillId,
      proposalId: "p2",
      runId: "r1",
      accountNumber: "ACC123",
      source: "live",
      symbol: "MSFT",
      side: "buy",
      quantity: 5,
      price: 400,
      notional: 2000,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: { test: true }
    });

    const mockGateway = {
      getEquityOrders: async () => [
        {
          id: brokerOrderId,
          symbol: "MSFT",
          side: "buy",
          type: "market",
          state: "cancelled",
          createdAt: new Date().toISOString()
        } as EquityOrder
      ]
    } as unknown as RobinhoodGateway;

    await reconcilePendingFills(mockGateway, "ACC123");

    const fills = listFillEvents("ACC123", "live");
    const matched = fills.find((f) => f.id === fillId);
    expect(matched).toBeDefined();
    expect(matched!.status).toBe("cancelled");
  });
});

describe("generateProactiveRiskProposals", () => {
  it("proposes sells when stop-loss or take-profit triggers are hit", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      riskRules: {
        stopLossPct: 8,
        takeProfitPct: 20
      }
    };

    const positions = [
      { symbol: "AAPL", quantity: 10, averageCost: 200, marketValue: 2000 }, // No breach
      { symbol: "MSFT", quantity: 5, averageCost: 400, marketValue: 1800 }, // Down 10% (breaches 8% stop-loss)
      { symbol: "NVDA", quantity: 8, averageCost: 100, marketValue: 1000 }  // Up 25% (breaches 20% take-profit)
    ];

    const currentPrices = {
      AAPL: 200,
      MSFT: 360,
      NVDA: 125
    };

    const proposals = generateProactiveRiskProposals(positions, currentPrices, policy);

    expect(proposals).toHaveLength(2);
    
    const msft = proposals.find((p) => p.symbol === "MSFT");
    expect(msft).toBeDefined();
    expect(msft!.side).toBe("sell");
    expect(msft!.quantity).toBe(5);
    expect(msft!.rationale).toContain("stop-loss");

    const nvda = proposals.find((p) => p.symbol === "NVDA");
    expect(nvda).toBeDefined();
    expect(nvda!.side).toBe("sell");
    expect(nvda!.quantity).toBe(8);
    expect(nvda!.rationale).toContain("take-profit");
  });

  it("returns nothing if no positions breach any thresholds", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      riskRules: {
        stopLossPct: 8,
        takeProfitPct: 20
      }
    };

    const positions = [
      { symbol: "AAPL", quantity: 10, averageCost: 200, marketValue: 2000 }
    ];

    const currentPrices = {
      AAPL: 195 // down 2.5%
    };

    const proposals = generateProactiveRiskProposals(positions, currentPrices, policy);
    expect(proposals).toHaveLength(0);
  });
});
