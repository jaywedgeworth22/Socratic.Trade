import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateStop, runSyntheticStopMonitor } from "../src/lib/synthetic-stops";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { TradingPolicy } from "../src/lib/types";

const broker = vi.hoisted(() => ({
  positions: [] as Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>,
  quotes: {} as Record<string, { price?: number }>,
  placed: [] as Array<{ side: string; quantity: number; symbol: string }>
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getEquityPositions: async () => broker.positions,
    getEquityQuotes: async () => broker.quotes,
    placeEquityOrder: async (order: { side: string; quantity: number; symbol: string }) => {
      broker.placed.push(order);
      return { orderId: "ord-1" };
    }
  })
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-synthstops-${randomUUID()}.db`)}`;
});

const longBase = { side: "long" as const, extremePrice: 100, trailPercent: 5, trailAmount: undefined, lastPrice: 100 };

describe("evaluateStop (synthetic trailing stop)", () => {
  it("raises the extreme as a long climbs and does not trigger above the trail", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 100, lastPrice: 105 }, 110);
    expect(r.newExtreme).toBe(110);
    expect(r.triggerPrice).toBeCloseTo(104.5); // 110 * (1 - 5%)
    expect(r.triggered).toBe(false);
  });

  it("triggers a long when price falls trailPercent below the extreme", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 110, lastPrice: 109 }, 104); // 104 <= 104.5
    expect(r.triggered).toBe(true);
    expect(r.newExtreme).toBe(110); // a pullback never raises the extreme
  });

  it("ignores a bad tick (>10% off last price): no extreme move, no trigger", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 110, lastPrice: 110 }, 60); // -45% spurious print
    expect(r.badTick).toBe(true);
    expect(r.newExtreme).toBe(110);
    expect(r.triggered).toBe(false);
  });

  it("triggers a short when price rises trailPercent above the low extreme", () => {
    const r = evaluateStop({ side: "short", extremePrice: 100, trailPercent: 5, trailAmount: undefined, lastPrice: 101 }, 106);
    expect(r.triggerPrice).toBeCloseTo(105); // 100 * (1 + 5%)
    expect(r.triggered).toBe(true);
  });

  it("lowers the extreme as a short falls and supports an absolute trail amount", () => {
    const r = evaluateStop({ side: "short", extremePrice: 100, trailPercent: undefined, trailAmount: 3, lastPrice: 99 }, 95);
    expect(r.newExtreme).toBe(95); // a short's extreme tracks DOWN
    expect(r.triggerPrice).toBeCloseTo(98); // 95 + 3
    expect(r.triggered).toBe(false); // 95 < 98, not yet
  });
});

describe("runSyntheticStopMonitor (orchestration)", () => {
  function policyFor(account: string): TradingPolicy {
    return {
      ...DEFAULT_POLICY,
      accountNumber: account,
      paperMode: true,
      shortSellingEnabled: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 }
    };
  }

  beforeEach(() => {
    broker.positions = [];
    broker.quotes = {};
    broker.placed = [];
  });

  it("auto-registers and fires a SELL to exit a long when the trail breaches (running)", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } }; // extreme 100, trail 5% → trigger ≤95; 90 breaches
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LONG"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(10);
  });

  it("fires a COVER to exit a short when the trail breaches (running)", async () => {
    broker.positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -500 }];
    broker.quotes = { TSLA: { price: 110 } }; // short extreme 100, trail 5% → trigger ≥105; 110 breaches
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SHORT"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("cover");
    expect(broker.placed[0].quantity).toBe(5);
  });

  it("suppresses the exit order when not running (would-trigger only)", async () => {
    broker.positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -500 }];
    broker.quotes = { TSLA: { price: 110 } };
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SUPPRESS"), false);
    expect(result.triggered).toBe(1);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
  });
});
