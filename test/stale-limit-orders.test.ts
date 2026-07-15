import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EquityOrder } from "../src/lib/types";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stale-limit-${randomUUID()}.db`)}`;
});

describe("stale limit order alerts", () => {
  const now = new Date("2026-06-30T16:30:00.000Z");

  it("detects working limit orders older than the policy threshold", async () => {
    const { listStaleLimitOrders } = await import("../src/lib/stale-limit-orders");

    const stale = listStaleLimitOrders(
      [
        order({ id: "stale-limit", createdAt: "2026-06-30T16:00:00.000Z", state: "accepted", type: "limit" }),
        order({ id: "fresh-limit", createdAt: "2026-06-30T16:20:00.000Z", state: "accepted", type: "limit" }),
        order({ id: "filled-limit", createdAt: "2026-06-30T15:00:00.000Z", state: "filled", type: "limit", filledQuantity: 10 }),
        order({ id: "old-market", createdAt: "2026-06-30T15:00:00.000Z", state: "accepted", type: "market" })
      ],
      { staleLimitOrderMinutes: 15 },
      now
    );

    expect(stale.map((item) => item.order.id)).toEqual(["stale-limit"]);
    expect(stale[0]?.ageMinutes).toBe(30);
    expect(stale[0]?.remainingQuantity).toBe(10);
  });

  it("does not alert on a held bracket exit leg, even past the threshold", async () => {
    const { listStaleLimitOrders } = await import("../src/lib/stale-limit-orders");

    // Bracket take-profit/stop-loss legs are created alongside the entry order but sit in
    // Alpaca's "held" state until the entry fills — they cannot execute yet, so staleness
    // (and the "cancel/reprice" advice that comes with it) is not actionable.
    const stale = listStaleLimitOrders(
      [
        order({
          id: "held-exit-leg",
          side: "sell",
          state: "held",
          type: "limit",
          createdAt: "2026-06-30T15:00:00.000Z"
        })
      ],
      { staleLimitOrderMinutes: 15 },
      now
    );

    expect(stale).toEqual([]);
  });

  it("alerts a bracket exit leg once it activates, measured from activation not creation", async () => {
    const { listStaleLimitOrders } = await import("../src/lib/stale-limit-orders");

    // Same leg as above, but the entry has now filled: Alpaca transitions the leg held -> new
    // and bumps updatedAt. Age must be measured from that activation, not from createdAt (which
    // predates the entry fill by hours) and not suppressed just because it was once held.
    const activatedButFresh = listStaleLimitOrders(
      [
        order({
          id: "activated-exit-leg",
          side: "sell",
          state: "new",
          type: "limit",
          createdAt: "2026-06-30T10:00:00.000Z",
          updatedAt: "2026-06-30T16:20:00.000Z" // activated 10 minutes ago — under threshold
        })
      ],
      { staleLimitOrderMinutes: 15 },
      now
    );
    expect(activatedButFresh).toEqual([]);

    const activatedAndStale = listStaleLimitOrders(
      [
        order({
          id: "activated-exit-leg",
          side: "sell",
          state: "new",
          type: "limit",
          createdAt: "2026-06-30T10:00:00.000Z",
          updatedAt: "2026-06-30T16:00:00.000Z" // activated 30 minutes ago — over threshold
        })
      ],
      { staleLimitOrderMinutes: 15 },
      now
    );
    expect(activatedAndStale.map((item) => item.order.id)).toEqual(["activated-exit-leg"]);
    expect(activatedAndStale[0]?.ageMinutes).toBe(30);
  });

  it("records one notification per stale order and threshold", async () => {
    const { getPolicy, listNotificationEvents } = await import("../src/lib/db");
    const { notifyStaleLimitOrders } = await import("../src/lib/stale-limit-orders");
    const policy = {
      ...getPolicy("local"),
      accountNumber: "APCA-PAPER",
      connectedAccountId: "acct-alpaca-paper",
      staleLimitOrderMinutes: 15
    };
    const orders = [order({ id: "stale-limit", createdAt: "2026-06-30T16:00:00.000Z", state: "accepted" })];

    const first = await notifyStaleLimitOrders({ userId: "local", policy, orders, now });
    const second = await notifyStaleLimitOrders({ userId: "local", policy, orders, now });

    expect(first.alerted).toBe(1);
    expect(second.alerted).toBe(0);
    const events = listNotificationEvents("local", 10).filter((event) => event.type === "limit_order_stale");
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("AAPL BUY limit order still working");
    expect(events[0]?.payload).toMatchObject({
      ageMinutes: 30,
      thresholdMinutes: 15,
      remainingQuantity: 10
    });
  });
});

function order(input: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "order-1",
    symbol: "AAPL",
    side: "buy",
    type: "limit",
    state: "accepted",
    quantity: 10,
    filledQuantity: 0,
    createdAt: "2026-06-30T16:00:00.000Z",
    ...input
  };
}
