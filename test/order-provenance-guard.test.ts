import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway, ConnectedAccount, EquityOrder, EquityOrderInput, EquityPosition, TradingPolicy } from "../src/lib/types";

const broker = vi.hoisted(() => ({
  gateway: null as BrokerGateway | null
}));

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: () => {
      if (!broker.gateway) throw new Error("broker gateway not configured for test");
      return broker.gateway;
    }
  };
});

beforeEach(() => {
  vi.resetModules();
  broker.gateway = null;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-order-provenance-${randomUUID()}.db`)}`;
});

describe("order provenance guard", () => {
  it("does not auto-remediate a stale activated bracket take-profit leg", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const { getDb } = await import("../src/lib/db");
    const now = new Date("2026-06-30T16:30:00.000Z");
    const staleBracketTp = order({
      id: "bracket-tp-1",
      side: "sell",
      type: "limit",
      state: "new",
      orderClass: "bracket",
      clientOrderId: "proposal-ref-bracket-tp",
      createdAt: "2026-06-30T10:00:00.000Z",
      updatedAt: "2026-06-30T16:00:00.000Z"
    });
    const gateway = gatewayMock({ orders: [[staleBracketTp]], positions: [position({ quantity: 10 })] });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: [staleBracketTp],
      now
    });

    expect(out).toMatchObject({ attempted: 0, remediated: 0, deferred: 1 });
    const row = getDb()
      .prepare("SELECT 1 FROM order_replacements WHERE original_order_id = ?")
      .get("bracket-tp-1");
    expect(row).toBeUndefined();
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("does not auto-remediate a stale owner-placed GTC sell without clientOrderId", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const { getDb } = await import("../src/lib/db");
    const staleOwnerSell = order({
      id: "owner-gtc-1",
      side: "sell",
      type: "limit",
      state: "accepted",
      clientOrderId: undefined,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const gateway = gatewayMock({ orders: [[staleOwnerSell]], positions: [position({ quantity: 10 })] });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: [staleOwnerSell]
    });

    expect(out).toMatchObject({ attempted: 0, remediated: 0, deferred: 1 });
    const row = getDb()
      .prepare("SELECT 1 FROM order_replacements WHERE original_order_id = ?")
      .get("owner-gtc-1");
    expect(row).toBeUndefined();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("does not re-place a protective stop the owner just cancelled", async () => {
    const { cancelWorkingOrder } = await import("../src/lib/order-cancel");
    const { reconcileBrokerProtectiveStops } = await import("../src/lib/broker-protective-stops");
    const { hasOwnerCancelledProtectiveStop } = await import("../src/lib/order-provenance");
    const { listBrokerProtectiveStops, setPolicy, upsertBrokerProtectiveStop } = await import("../src/lib/db");

    const userId = "local";
    const accountNumber = "PS-OWNER-CANCEL";
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber,
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8 }
    };
    setPolicy(policy, userId);

    const stopOrderId = "broker-stop-1";
    upsertBrokerProtectiveStop({
      id: `protstop-${userId}-${accountNumber}-AAPL`,
      userId,
      accountNumber,
      symbol: "AAPL",
      brokerOrderId: stopOrderId,
      quantity: 10,
      stopPrice: 92,
      status: "resting",
      kind: "fixed"
    });

    const openStop = order({
      id: stopOrderId,
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "open",
      clientOrderId: "protstop-local-PS-OWNER-CANCEL-AAPL-1"
    });
    const gw = gatewayMock({ orders: [[openStop]] });
    broker.gateway = gw;

    await cancelWorkingOrder({ userId, orderId: stopOrderId, source: "console" });
    expect(gw.cancelEquityOrder).toHaveBeenCalledWith(accountNumber, stopOrderId);
    expect(hasOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL")).toBe(true);
    expect(listBrokerProtectiveStops(accountNumber, userId)).toHaveLength(0);

    const canceledOrders = [order({
      id: stopOrderId,
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "canceled",
      clientOrderId: "protstop-local-PS-OWNER-CANCEL-AAPL-1"
    })];
    const reconcileGw = gatewayMock({ orders: [canceledOrders] });

    const result = await reconcileBrokerProtectiveStops({
      userId,
      policy,
      accountNumber,
      gateway: reconcileGw,
      positions: [position({ quantity: 10 })],
      executionMode: "broker/live",
      running: true,
      orders: canceledOrders,
      ordersListed: true
    });

    expect(result.placed).toBe(0);
    expect(reconcileGw.placeEquityOrder).not.toHaveBeenCalled();
  });
});

function paperPolicy(): TradingPolicy & { accountNumber: string } {
  return {
    ...DEFAULT_POLICY,
    connectedAccountId: "acct-paper",
    accountNumber: "APCA-PAPER"
  };
}

function account(environment: "paper" | "live"): ConnectedAccount {
  return {
    id: environment === "paper" ? "acct-paper" : "acct-live",
    userId: "local",
    broker: "alpaca",
    environment,
    accountNumber: environment === "paper" ? "APCA-PAPER" : "APCA-LIVE",
    label: environment === "paper" ? "Alpaca Paper" : "Alpaca Brokerage",
    isActive: true,
    capabilities: {
      equityTrading: true,
      shortSelling: false,
      optionsTrading: false,
      futuresTrading: false,
      cryptoTrading: false,
      marginEnabled: false,
      accountType: "brokerage"
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  };
}

function order(overrides: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "limit-1",
    symbol: "AAPL",
    side: "buy",
    type: "limit",
    state: "accepted",
    quantity: 10,
    filledQuantity: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function position(overrides: Partial<EquityPosition> = {}): EquityPosition {
  return { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000, ...overrides };
}

function gatewayMock(input: {
  orders: EquityOrder[][];
  positions?: EquityPosition[];
  execution?: { orderId?: string; refId: string; state: string; filledQuantity?: number; averagePrice?: number; raw: unknown };
}): BrokerGateway {
  const orderResponses = [...input.orders];
  return {
    getAccounts: vi.fn(async () => []),
    getPortfolio: vi.fn(),
    getEquityPositions: vi.fn(async () => input.positions ?? []),
    getEquityOrders: vi.fn(async () => orderResponses.shift() ?? input.orders.at(-1) ?? []),
    getEquityQuotes: vi.fn(async () => ({})),
    getEquityTradability: vi.fn(async () => ({})),
    reviewEquityOrder: vi.fn(async (orderInput: EquityOrderInput) => ({
      estimatedNotional: Math.abs((orderInput.quantity ?? 0) * 100),
      alerts: [],
      raw: { reviewed: true }
    })),
    placeEquityOrder: vi.fn(async () => (
      input.execution ?? { orderId: "market-1", refId: "ref-1", state: "accepted", raw: { id: "market-1" } }
    )),
    cancelEquityOrder: vi.fn(async (_accountNumber: string, orderId: string) => ({
      orderId,
      refId: "cancel-ref",
      state: "canceled",
      raw: { canceled: true }
    }))
  };
}
