import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { TradingPolicy } from "../src/lib/types";
import {
  extendedHoursExitBufferBps,
  marketableLimitExitPrice,
  resolveProtectiveExitRouting
} from "../src/lib/protective-exit-routing";
import { generateProactiveRiskProposals } from "../src/lib/strategy";

// Build a UTC Date at a given ET wall-clock time. June is always EDT (UTC-4), so utcHour = etHour + 4.
// 2026-06-10 is a Wednesday. Pre = 08:00 ET, regular = 10:00 ET, post = 17:00 ET, closed = 02:00 ET
// (before the 04:00 pre-market open). Keep etHour+4 < 24 so the UTC string stays same-day/valid.
function etDate(etHour: number, etMinute = 0): Date {
  const utcHour = etHour + 4;
  return new Date(`2026-06-10T${String(utcHour).padStart(2, "0")}:${String(etMinute).padStart(2, "0")}:00Z`);
}
const PRE = etDate(8);
const REGULAR = etDate(10);
const POST = etDate(17);
const CLOSED = etDate(2);

const policyWith = (over: Partial<TradingPolicy>): TradingPolicy => ({ ...DEFAULT_POLICY, ...over });

describe("extendedHoursExitBufferBps", () => {
  it("undefined when the toggle is off (default), regardless of session", () => {
    expect(extendedHoursExitBufferBps(DEFAULT_POLICY, PRE)).toBeUndefined();
    expect(extendedHoursExitBufferBps(DEFAULT_POLICY, POST)).toBeUndefined();
  });

  it("undefined in a regular or closed session even when the toggle is on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(extendedHoursExitBufferBps(p, REGULAR)).toBeUndefined();
    expect(extendedHoursExitBufferBps(p, CLOSED)).toBeUndefined();
  });

  it("returns the default 15 bps in pre/post when the toggle is on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(extendedHoursExitBufferBps(p, PRE)).toBe(15);
    expect(extendedHoursExitBufferBps(p, POST)).toBe(15);
  });

  it("honors a tuned buffer", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true, tuning: { marketableLimitBufferBps: 25 } });
    expect(extendedHoursExitBufferBps(p, PRE)).toBe(25);
  });

  it("undefined when limit orders are not a permitted order type (a limit is mandatory in extended hours)", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true, permittedOrderTypes: ["market"] });
    expect(extendedHoursExitBufferBps(p, PRE)).toBeUndefined();
  });
});

describe("marketableLimitExitPrice", () => {
  it("a SELL (long exit) crosses DOWN off the ref price", () => {
    expect(marketableLimitExitPrice(100, "sell", 15)).toBe(99.85); // 100 * (1 - 0.0015)
  });
  it("a COVER (short buy-to-close) crosses UP off the ref price", () => {
    expect(marketableLimitExitPrice(100, "cover", 15)).toBe(100.15); // 100 * (1 + 0.0015)
  });
  it("undefined for a non-positive price", () => {
    expect(marketableLimitExitPrice(0, "sell", 15)).toBeUndefined();
    expect(marketableLimitExitPrice(-5, "cover", 15)).toBeUndefined();
  });
});

describe("resolveProtectiveExitRouting", () => {
  it("market + regular_hours when the toggle is off (queue to the open)", () => {
    expect(resolveProtectiveExitRouting(DEFAULT_POLICY, "sell", 100, PRE)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
  });

  it("market + regular_hours in a regular session even with the toggle on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", 100, REGULAR)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
  });

  it("marketable-limit + extended_hours in pre/post when the toggle is on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", 100, PRE)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 99.85
    });
    expect(resolveProtectiveExitRouting(p, "cover", 100, POST)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 100.15
    });
  });

  it("falls back to market/regular when no usable price is available", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", undefined, PRE)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
  });
});

describe("generateProactiveRiskProposals — extended-hours routing", () => {
  // MSFT long down 10% (breaches the 8% stop): a proactive SELL exit is generated.
  const positions = [{ symbol: "MSFT", quantity: 5, averageCost: 400, marketValue: 1800 }];
  const currentPrices = { MSFT: 360 };
  const policy = policyWith({ riskRules: { stopLossPct: 8 } });

  it("defaults to a market order that queues to the open (no buffer passed)", () => {
    const [exit] = generateProactiveRiskProposals(positions, currentPrices, policy, {}, {});
    expect(exit).toMatchObject({ symbol: "MSFT", side: "sell", type: "market", marketHours: "regular_hours" });
    expect(exit.limitPrice).toBeUndefined();
  });

  it("becomes a marketable-limit tagged extended_hours when a buffer is supplied", () => {
    const [exit] = generateProactiveRiskProposals(positions, currentPrices, policy, {}, {}, 15);
    expect(exit).toMatchObject({
      symbol: "MSFT",
      side: "sell",
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 359.46 // 360 * (1 - 0.0015)
    });
  });

  it("routes a SHORT cover exit UP through the price in extended hours", () => {
    // Short at 100, now 112 → a short is down 12%, breaching the 8% stop → COVER.
    const shortPos = [{ symbol: "TSLA", quantity: -3, averageCost: 100, marketValue: -336 }];
    const shortPolicy = policyWith({ riskRules: { stopLossPct: 8 }, shortSellingEnabled: true });
    const [exit] = generateProactiveRiskProposals(shortPos, { TSLA: 112 }, shortPolicy, {}, {}, 15);
    expect(exit).toMatchObject({
      symbol: "TSLA",
      side: "cover",
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 112.17 // 112 * (1 + 0.0015)
    });
  });
});
