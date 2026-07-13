import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway, ConnectedAccount, EquityOrder, EquityOrderInput, EquityPosition } from "../src/lib/types";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-order-replacement-${randomUUID()}.db`)}`;
});

describe("market replacement for stale limit orders", () => {
  it("cancels a stale limit order, rechecks broker state, and submits only remaining shares as market", async () => {
    const { replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const { listFillEvents } = await import("../src/lib/db");
    const original = order({ id: "limit-1", quantity: 10, filledQuantity: 2, state: "accepted" });
    const canceled = order({ id: "limit-1", quantity: 10, filledQuantity: 2, state: "canceled" });
    const gateway = gatewayMock({
      orders: [[original], [canceled]],
      execution: { orderId: "market-1", refId: "ref-1", state: "accepted", raw: { id: "market-1" } }
    });

    const result = await replaceStaleLimitOrderWithMarket({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orderId: "limit-1",
      cancelSettleMs: 0
    });

    expect(result).toMatchObject({
      status: "replaced",
      canceledOrderId: "limit-1",
      replacementOrderId: "market-1",
      remainingQuantity: 8,
      fillStatus: "pending_reconciliation"
    });
    expect(gateway.cancelEquityOrder).toHaveBeenCalledWith("APCA-PAPER", "limit-1");
    expect(gateway.reviewEquityOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 8
    }));
    expect(gateway.placeEquityOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 8,
      refId: expect.any(String)
    }));

    const fills = listFillEvents("APCA-PAPER", "paper", 10, "local");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      brokerOrderId: "market-1",
      symbol: "AAPL",
      side: "buy",
      quantity: 8,
      status: "pending_reconciliation",
      executionMode: "broker/paper"
    });
  });

  it("requires typed confirmation before replacing a live Brokerage order", async () => {
    const { MarketReplaceConfirmationError, replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const gateway = gatewayMock({ orders: [[order({ id: "live-limit" })]] });

    await expect(
      replaceStaleLimitOrderWithMarket({
        userId: "local",
        policy: livePolicy(),
        activeAccount: account("live"),
        gateway,
        orderId: "live-limit",
        cancelSettleMs: 0
      })
    ).rejects.toMatchObject({
      name: "MarketReplaceConfirmationError",
      expectedText: "REPLACE LIVE AAPL"
    });
    expect(MarketReplaceConfirmationError).toBeDefined();
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("does not place a market order while cancel is still active at the broker", async () => {
    const { MarketReplacePreconditionError, replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const original = order({ id: "limit-1", state: "accepted" });
    const pendingCancel = order({ id: "limit-1", state: "pending_cancel" });
    const gateway = gatewayMock({ orders: [[original], [pendingCancel]] });

    const result = await replaceStaleLimitOrderWithMarket({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orderId: "limit-1",
      cancelSettleMs: 0
    });
    expect(result).toMatchObject({
      status: "pending_cancel",
      canceledOrderId: "limit-1",
      remainingQuantity: 10
    });
    expect(gateway.cancelEquityOrder).toHaveBeenCalledWith("APCA-PAPER", "limit-1");
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });
});

describe("autoRemediateStaleExitOrders — MU deadlock backstop", () => {
  it("auto-cancel-replaces a stale EXIT (sell) limit with a market order on paper", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const staleSell = order({ id: "sell-1", side: "sell", quantity: 5, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const canceled = order({ id: "sell-1", side: "sell", quantity: 5, filledQuantity: 0, state: "canceled" });
    const gateway = gatewayMock({
      orders: [[staleSell], [canceled]],
      positions: [position({ quantity: 5 })],
      execution: { orderId: "mkt-sell-1", refId: "r", state: "accepted", raw: {} }
    });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: [staleSell]
    });

    expect(out).toMatchObject({ attempted: 1, remediated: 1, deferred: 0 });
    expect(gateway.placeEquityOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: "AAPL", side: "sell", type: "market", quantity: 5 }));
  });

  it("never auto-forces a stale ENTRY (buy) limit to market", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const staleBuy = order({ id: "buy-1", side: "buy", state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[staleBuy]] });

    const out = await autoRemediateStaleExitOrders({ userId: "local", policy: paperPolicy(), activeAccount: account("paper"), gateway, orders: [staleBuy] });

    expect(out).toMatchObject({ attempted: 0, remediated: 0 });
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("defers a live stale EXIT to the human when typed confirmation is required", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const staleSell = order({ id: "sell-live", side: "sell", state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[staleSell]] });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: { ...livePolicy(), requireTypedConfirmation: true },
      activeAccount: account("live"),
      gateway,
      orders: [staleSell]
    });

    expect(out).toMatchObject({ deferred: 1, attempted: 0, remediated: 0 });
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("is a no-op when autoRemediateStaleExits is disabled", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const staleSell = order({ id: "sell-off", side: "sell", state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[staleSell]] });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: { ...paperPolicy(), autoRemediateStaleExits: false },
      activeAccount: account("paper"),
      gateway,
      orders: [staleSell]
    });

    expect(out).toMatchObject({ attempted: 0, remediated: 0, deferred: 0 });
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("does NOT remediate the same stale EXIT twice within the cooldown (double-sell guard)", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const staleSell = order({ id: "sell-cooldown", side: "sell", quantity: 5, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const canceled = order({ id: "sell-cooldown", side: "sell", quantity: 5, filledQuantity: 0, state: "canceled" });
    const gateway = gatewayMock({
      orders: [[staleSell], [canceled]],
      positions: [position({ quantity: 5 })],
      execution: { orderId: "mkt-cd", refId: "r", state: "accepted", raw: {} }
    });

    // First pass cancel-replaces once.
    const first = await autoRemediateStaleExitOrders({ userId: "local", policy: paperPolicy(), activeAccount: account("paper"), gateway, orders: [staleSell] });
    expect(first).toMatchObject({ attempted: 1, remediated: 1 });
    expect(gateway.placeEquityOrder).toHaveBeenCalledTimes(1);

    // The broker is slow to reflect the cancel, so the order still appears working on the next tick.
    // The cooldown must SKIP it — no second market sell for the same shares (the Finding-1 double-sell).
    const second = await autoRemediateStaleExitOrders({ userId: "local", policy: paperPolicy(), activeAccount: account("paper"), gateway, orders: [staleSell] });
    expect(second).toMatchObject({ attempted: 0, remediated: 0 });
    expect(gateway.placeEquityOrder).toHaveBeenCalledTimes(1); // still exactly one
  });
});

describe("held-leg + position-backed guards — 2026-07-08 PG/T naked-short regression (PR #1036)", () => {
  it("never remediates a broker-HELD protective exit leg of an unfilled entry, even with a position present", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    // The production shape: entry buy limit still working + its protective sell leg in Alpaca state
    // "held" (pending activation because the entry never filled). A position for the symbol exists
    // here on purpose — the held leg must be excluded by CLASSIFICATION, not just the position guard.
    const heldExitLeg = order({ id: "held-leg-1", symbol: "PG", side: "sell", quantity: 12, filledQuantity: 0, state: "held", createdAt: "2026-01-01T00:00:00.000Z" });
    const entryBuy = order({ id: "entry-1", symbol: "PG", side: "buy", quantity: 12, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[heldExitLeg, entryBuy]], positions: [position({ symbol: "PG", quantity: 12 })] });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: [heldExitLeg, entryBuy]
    });

    expect(out).toMatchObject({ attempted: 0, remediated: 0, deferred: 0 });
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("still remediates a genuinely stranded exit in an active state backed by a real position (the MU case)", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const strandedSell = order({ id: "mu-sell", symbol: "MU", side: "sell", quantity: 1, filledQuantity: 0, state: "new", createdAt: "2026-01-01T00:00:00.000Z" });
    const canceled = order({ id: "mu-sell", symbol: "MU", side: "sell", quantity: 1, filledQuantity: 0, state: "canceled" });
    const gateway = gatewayMock({
      orders: [[strandedSell], [canceled]],
      positions: [position({ symbol: "MU", quantity: 1 })],
      execution: { orderId: "mkt-mu", refId: "r", state: "accepted", raw: {} }
    });

    const out = await autoRemediateStaleExitOrders({ userId: "local", policy: paperPolicy(), activeAccount: account("paper"), gateway, orders: [strandedSell] });

    expect(out).toMatchObject({ attempted: 1, remediated: 1 });
    expect(gateway.placeEquityOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: "MU", side: "sell", type: "market", quantity: 1 }));
  });

  it("skips the market replacement with an audit receipt when NO position backs the exit, cancelling nothing", async () => {
    const { MarketReplacePreconditionError, replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const { latestAuditByKind } = await import("../src/lib/db");
    const staleSell = order({ id: "t-sell", symbol: "T", side: "sell", quantity: 93, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[staleSell]], positions: [] });

    await expect(
      replaceStaleLimitOrderWithMarket({
        userId: "local",
        policy: paperPolicy(),
        activeAccount: account("paper"),
        gateway,
        orderId: "t-sell",
        cancelSettleMs: 0
      })
    ).rejects.toMatchObject({ name: "MarketReplacePreconditionError", status: 409 });
    expect(MarketReplacePreconditionError).toBeDefined();
    // The original order must be left fully intact — no cancel, no market order.
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();

    const receipt = latestAuditByKind("stale_exit_remediation_skipped_no_position", "local", "acct-paper");
    expect(receipt?.payload).toMatchObject({
      orderId: "t-sell",
      symbol: "T",
      side: "sell",
      remainingQuantity: 93,
      positionQuantity: 0,
      backingQuantity: 0,
      reason: "no_position"
    });
  });

  it("skips the replacement when the position is smaller than the order's remaining quantity", async () => {
    const { replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const { latestAuditByKind } = await import("../src/lib/db");
    const staleSell = order({ id: "unh-sell", symbol: "UNH", side: "sell", quantity: 4, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[staleSell]], positions: [position({ symbol: "UNH", quantity: 2 })] });

    await expect(
      replaceStaleLimitOrderWithMarket({
        userId: "local",
        policy: paperPolicy(),
        activeAccount: account("paper"),
        gateway,
        orderId: "unh-sell",
        cancelSettleMs: 0
      })
    ).rejects.toMatchObject({ name: "MarketReplacePreconditionError", status: 409 });
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();

    const receipt = latestAuditByKind("stale_exit_remediation_skipped_no_position", "local", "acct-paper");
    expect(receipt?.payload).toMatchObject({
      orderId: "unh-sell",
      symbol: "UNH",
      remainingQuantity: 4,
      positionQuantity: 2,
      backingQuantity: 2,
      reason: "position_smaller_than_order"
    });
  });

  it("auto-remediation records the unbacked exit as failed (not remediated) and leaves it for the human surface", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const { latestAuditByKind } = await import("../src/lib/db");
    const staleSell = order({ id: "t-sell-auto", symbol: "T", side: "sell", quantity: 93, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[staleSell]], positions: [] });

    const out = await autoRemediateStaleExitOrders({ userId: "local", policy: paperPolicy(), activeAccount: account("paper"), gateway, orders: [staleSell] });

    expect(out).toMatchObject({ attempted: 1, remediated: 0 });
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
    expect(latestAuditByKind("stale_exit_remediation_skipped_no_position", "local", "acct-paper")?.payload).toMatchObject({ orderId: "t-sell-auto" });
    expect(latestAuditByKind("stale_exit_auto_remediation_failed", "local", "acct-paper")?.payload).toMatchObject({ orderId: "t-sell-auto" });
  });

  it("cover exits require a SHORT position — a long position does not back a cover", async () => {
    const { replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const staleCover = order({ id: "cover-1", symbol: "PG", side: "cover", quantity: 3, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[staleCover]], positions: [position({ symbol: "PG", quantity: 3 })] });

    await expect(
      replaceStaleLimitOrderWithMarket({
        userId: "local",
        policy: paperPolicy(),
        activeAccount: account("paper"),
        gateway,
        orderId: "cover-1",
        cancelSettleMs: 0
      })
    ).rejects.toMatchObject({ name: "MarketReplacePreconditionError", status: 409 });
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });
});

describe("manual-path held-leg, post-cancel TOCTOU, and in-flight guards — adversarial review round 2", () => {
  it("rejects a broker-HELD leg on the MANUAL path with 409 and cancels nothing, even when an old position covers it", async () => {
    const { replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const { latestAuditByKind } = await import("../src/lib/db");
    // The review's exact scenario: 100 XYZ held from an OLD lot, plus a NEW 50-share bracket whose
    // entry is unfilled — its protective sell leg sits in broker state "held". The position-backed
    // guard alone passes (100 >= 50), so the held-state rejection in the SHARED path must fire
    // before any cancel. State uses mixed case + whitespace to pin the normalization.
    const heldLeg = order({ id: "held-manual-1", symbol: "XYZ", side: "sell", quantity: 50, filledQuantity: 0, state: " Held ", createdAt: "2026-01-01T00:00:00.000Z" });
    const gateway = gatewayMock({ orders: [[heldLeg]], positions: [position({ symbol: "XYZ", quantity: 100 })] });

    await expect(
      replaceStaleLimitOrderWithMarket({
        userId: "local",
        policy: paperPolicy(),
        activeAccount: account("paper"),
        gateway,
        orderId: "held-manual-1",
        cancelSettleMs: 0
      })
    ).rejects.toMatchObject({
      name: "MarketReplacePreconditionError",
      status: 409,
      message: expect.stringContaining("broker-held")
    });
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
    expect(latestAuditByKind("order_replace_market_rejected_held_leg", "local", "acct-paper")?.payload).toMatchObject({
      orderId: "held-manual-1",
      symbol: "XYZ",
      side: "sell",
      remainingQuantity: 50
    });
  });

  it("re-verifies the backing position AFTER the cancel and aborts placement with the distinct receipt when it shrank", async () => {
    const { replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const { latestAuditByKind } = await import("../src/lib/db");
    const staleSell = order({ id: "toctou-sell", symbol: "MU", side: "sell", quantity: 5, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const canceled = order({ id: "toctou-sell", symbol: "MU", side: "sell", quantity: 5, filledQuantity: 0, state: "canceled" });
    const gateway = gatewayMock({ orders: [[staleSell], [canceled]] });
    // Pre-cancel fetch sees 5 shares (guard passes); post-cancel re-fetch sees the position shrunk
    // to 1 (a concurrent fill during cancel+settle). The market order must NOT be placed.
    (gateway.getEquityPositions as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([position({ symbol: "MU", quantity: 5 })])
      .mockResolvedValueOnce([position({ symbol: "MU", quantity: 1 })]);

    await expect(
      replaceStaleLimitOrderWithMarket({
        userId: "local",
        policy: paperPolicy(),
        activeAccount: account("paper"),
        gateway,
        orderId: "toctou-sell",
        cancelSettleMs: 0
      })
    ).rejects.toMatchObject({
      name: "MarketReplacePreconditionError",
      status: 409,
      message: expect.stringContaining("CANCELED and was NOT replaced")
    });
    // The cancel DID happen (the order cannot be resurrected) — but nothing was placed.
    expect(gateway.cancelEquityOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();

    const receipt = latestAuditByKind("stale_exit_replacement_aborted_post_cancel", "local", "acct-paper");
    expect(receipt?.payload).toMatchObject({
      orderId: "toctou-sell",
      symbol: "MU",
      side: "sell",
      remainingQuantity: 5,
      positionQuantity: 1,
      backingQuantity: 1,
      reason: "position_shrank_below_remaining"
    });
  });

  it("blocks concurrent replacement of the same order via the shared in-flight set — second entrant gets 409", async () => {
    const { replaceStaleLimitOrderWithMarket } = await import("../src/lib/order-replacement");
    const staleSell = order({ id: "race-sell-1", symbol: "MU", side: "sell", quantity: 5, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const canceled = order({ id: "race-sell-1", symbol: "MU", side: "sell", quantity: 5, filledQuantity: 0, state: "canceled" });
    const gateway = gatewayMock({
      orders: [[staleSell], [canceled]],
      positions: [position({ symbol: "MU", quantity: 5 })],
      execution: { orderId: "mkt-race", refId: "r", state: "accepted", raw: {} }
    });
    const args = {
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orderId: "race-sell-1",
      cancelSettleMs: 0
    };

    // First entrant claims the in-flight key synchronously before its first await; the second call
    // (a human click racing the auto tick) must be locked out immediately.
    const first = replaceStaleLimitOrderWithMarket(args);
    const second = replaceStaleLimitOrderWithMarket(args);

    await expect(second).rejects.toMatchObject({
      name: "MarketReplacePreconditionError",
      status: 409,
      message: expect.stringContaining("already being replaced")
    });
    await expect(first).resolves.toMatchObject({ status: "replaced", replacementOrderId: "mkt-race" });
    // Exactly ONE cancel and ONE market order across both requests — no double-sell.
    expect(gateway.cancelEquityOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeEquityOrder).toHaveBeenCalledTimes(1);

    // The lock is released in finally — a later, non-concurrent request is NOT permanently blocked.
    const afterOrders = order({ id: "race-sell-1", symbol: "MU", side: "sell", quantity: 5, filledQuantity: 0, state: "accepted", createdAt: "2026-01-01T00:00:00.000Z" });
    const afterCanceled = order({ id: "race-sell-1", symbol: "MU", side: "sell", quantity: 5, filledQuantity: 0, state: "canceled" });
    const freshGateway = gatewayMock({
      orders: [[afterOrders], [afterCanceled]],
      positions: [position({ symbol: "MU", quantity: 5 })],
      execution: { orderId: "mkt-race-2", refId: "r2", state: "accepted", raw: {} }
    });
    await expect(
      replaceStaleLimitOrderWithMarket({ ...args, gateway: freshGateway })
    ).resolves.toMatchObject({ status: "replaced", replacementOrderId: "mkt-race-2" });
  });
});

function paperPolicy() {
  return {
    ...DEFAULT_POLICY,
    activeBroker: "alpaca" as const,
    connectedAccountId: "acct-paper",
    accountNumber: "APCA-PAPER",
    staleLimitOrderMinutes: 15
  };
}

function livePolicy() {
  return {
    ...paperPolicy(),
    connectedAccountId: "acct-live",
    accountNumber: "APCA-LIVE"
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

describe("reconciliation and reconstruction recovery", () => {
  it("reconstructs original order from persisted DB columns if not returned by broker", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const { getDb } = await import("../src/lib/db");
    
    const db = getDb();
    const id = randomUUID();
    const refId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO order_replacements 
      (id, user_id, account_number, original_order_id, symbol, side, original_type, original_quantity, original_filled_quantity, replacement_ref_id, status, created_at, updated_at) 
      VALUES (?, 'local', 'APCA-PAPER', 'missing-order-1', 'AAPL', 'sell', 'limit', 10, 2, ?, 'cancel_confirmed', ?, ?)
    `).run(id, refId, now, now);

    const gateway = gatewayMock({
      orders: [[]],
      positions: [position({ symbol: "AAPL", quantity: 10 })],
      execution: { orderId: "replacement-market-1", refId, state: "accepted", raw: {} }
    });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: []
    });

    expect(out).toMatchObject({ remediated: 1 });
    expect(gateway.placeEquityOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "AAPL",
      side: "sell",
      type: "market",
      quantity: 8
    }));

    const record = db.prepare("SELECT status, replacement_order_id FROM order_replacements WHERE id = ?").get(id) as any;
    expect(record.status).toBe("replacement_confirmed");
    expect(record.replacement_order_id).toBe("replacement-market-1");
  });

  it("reconciles replacement_submitted rows by locating the order via clientOrderId at the broker", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const { getDb } = await import("../src/lib/db");

    const db = getDb();
    const id = randomUUID();
    const refId = "submitted-ref-1";
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO order_replacements 
      (id, user_id, account_number, original_order_id, symbol, side, original_type, original_quantity, original_filled_quantity, remaining_quantity, replacement_ref_id, status, created_at, updated_at) 
      VALUES (?, 'local', 'APCA-PAPER', 'limit-2', 'AAPL', 'sell', 'limit', 10, 0, 10, ?, 'replacement_submitted', ?, ?)
    `).run(id, refId, now, now);

    const submittedOrder = order({ id: "broker-market-2", type: "market", side: "sell", clientOrderId: refId, state: "filled", quantity: 10 });
    const gateway = gatewayMock({
      orders: [[submittedOrder]]
    });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: []
    });

    const record = db.prepare("SELECT status, replacement_order_id FROM order_replacements WHERE id = ?").get(id) as any;
    expect(record.status).toBe("replacement_confirmed");
    expect(record.replacement_order_id).toBe("broker-market-2");

    const fillExists = db.prepare("SELECT 1 FROM fill_events WHERE broker_order_id = 'broker-market-2'").get();
    expect(fillExists).toBeDefined();
  });
});
