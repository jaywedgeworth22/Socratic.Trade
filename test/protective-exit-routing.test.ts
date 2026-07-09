import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { TradeProposal, TradingPolicy } from "../src/lib/types";
import {
  extendedHoursExitBufferBps,
  marketableLimitExitPrice,
  repriceStoredProtectiveExit,
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

  it("falls back to the default for a stored zero/negative/non-finite buffer (it would invert the marketable price)", () => {
    for (const bad of [0, -10, Number.NaN]) {
      const p = policyWith({ allowExtendedHoursSyntheticStops: true, tuning: { marketableLimitBufferBps: bad } });
      expect(extendedHoursExitBufferBps(p, PRE)).toBe(15);
    }
  });

  it("caps an absurd stored buffer at 500 bps (typo/units-mistake guard)", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true, tuning: { marketableLimitBufferBps: 10_000 } });
    expect(extendedHoursExitBufferBps(p, PRE)).toBe(500);
  });

  it("undefined when limit orders are not a permitted order type (a limit is mandatory in extended hours)", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true, permittedOrderTypes: ["market"] });
    expect(extendedHoursExitBufferBps(p, PRE)).toBeUndefined();
  });
});

describe("marketableLimitExitPrice", () => {
  it("a SELL (long exit) crosses DOWN off the ref price when no bid is available", () => {
    expect(marketableLimitExitPrice({ price: 100 }, "sell", 15)).toBe(99.85); // 100 * (1 - 0.0015)
  });
  it("a COVER (short buy-to-close) crosses UP off the ref price when no ask is available", () => {
    expect(marketableLimitExitPrice({ price: 100 }, "cover", 15)).toBe(100.15); // 100 * (1 + 0.0015)
  });
  it("a SELL anchors to the BID, not the ask-biased composite price (bid 99 / ask 100 spread)", () => {
    // Off the composite (ask) the limit would be 99.85 — ABOVE the 99 bid, not marketable at all.
    expect(marketableLimitExitPrice({ price: 100, bid: 99, ask: 100 }, "sell", 15)).toBe(98.85); // 99 * (1 - 0.0015)
  });
  it("a COVER anchors to the ASK", () => {
    expect(marketableLimitExitPrice({ price: 99, bid: 99, ask: 100 }, "cover", 15)).toBe(100.15); // 100 * (1 + 0.0015)
  });
  it("a zero/absent bid (common on the free tier after hours) falls back to the composite price", () => {
    expect(marketableLimitExitPrice({ price: 100, bid: 0 }, "sell", 15)).toBe(99.85);
  });
  it("undefined when no usable anchor exists", () => {
    expect(marketableLimitExitPrice({ price: 0 }, "sell", 15)).toBeUndefined();
    expect(marketableLimitExitPrice({ price: -5 }, "cover", 15)).toBeUndefined();
    expect(marketableLimitExitPrice({}, "sell", 15)).toBeUndefined();
  });
});

describe("resolveProtectiveExitRouting", () => {
  it("market + regular_hours when the toggle is off (queue to the open)", () => {
    expect(resolveProtectiveExitRouting(DEFAULT_POLICY, "sell", { price: 100 }, PRE)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
  });

  it("market + regular_hours in a regular session even with the toggle on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, REGULAR)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
  });

  it("marketable-limit + extended_hours in pre/post when the toggle is on", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, PRE)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 99.85
    });
    expect(resolveProtectiveExitRouting(p, "cover", { price: 100 }, POST)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 100.15
    });
  });

  it("anchors the extended-hours SELL limit to the bid when one is supplied", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100, bid: 99, ask: 100 }, PRE)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 98.85
    });
  });

  it("keeps a FRACTIONAL exit quantity on market/regular (fractional orders are regular-hours-only)", () => {
    const p = policyWith({ allowExtendedHoursSyntheticStops: true });
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, PRE, 10.5)).toEqual({
      type: "market",
      marketHours: "regular_hours"
    });
    // A whole-share quantity still takes the extended-hours limit.
    expect(resolveProtectiveExitRouting(p, "sell", { price: 100 }, PRE, 10)).toEqual({
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 99.85
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

describe("repriceStoredProtectiveExit (approval-held exits)", () => {
  const storedExit: TradeProposal = {
    symbol: "AAPL",
    side: "sell",
    type: "limit",
    quantity: 5,
    limitPrice: 219.67, // priced off a $220 quote at generation time
    timeInForce: "gfd",
    marketHours: "extended_hours",
    rationale: "Proactive stop-loss exit.",
    tradeThesisTag: "Risk-Exit",
    entryMarketRegime: "Active Risk Check"
  };
  const p = policyWith({ allowExtendedHoursSyntheticStops: true });

  it("reprices a stale extended-hours limit off the FRESH bid so it is marketable again", () => {
    // The quote fell through the stored 219.67 limit while the card waited for approval.
    const repriced = repriceStoredProtectiveExit(storedExit, p, { price: 200, bid: 199, ask: 200 }, PRE);
    expect(repriced).toMatchObject({ type: "limit", marketHours: "extended_hours", limitPrice: 198.7 }); // 199 * (1 - 0.0015)
  });

  it("degrades to market/regular_hours when the extended session no longer applies at approval time", () => {
    const repriced = repriceStoredProtectiveExit(storedExit, p, { price: 200, bid: 199, ask: 200 }, REGULAR);
    expect(repriced).toMatchObject({ type: "market", marketHours: "regular_hours" });
    expect(repriced.limitPrice).toBeUndefined();
  });

  it("degrades to market/regular_hours when no fresh quote is available", () => {
    const repriced = repriceStoredProtectiveExit(storedExit, p, undefined, PRE);
    expect(repriced).toMatchObject({ type: "market", marketHours: "regular_hours" });
  });

  it("returns the proposal unchanged when the fresh routing matches the stored limit", () => {
    const fresh = repriceStoredProtectiveExit(storedExit, p, { price: 220, bid: 220, ask: 220.2 }, PRE);
    // 220 * (1 - 0.0015) = 219.67 — identical, so the exact same object passes through.
    expect(fresh).toBe(storedExit);
  });

  it("passes non-protective and non-extended-hours proposals through untouched", () => {
    const entry: TradeProposal = { ...storedExit, side: "buy", tradeThesisTag: "Momentum-Breakout" };
    expect(repriceStoredProtectiveExit(entry, p, { price: 1 }, PRE)).toBe(entry);
    const regularExit: TradeProposal = { ...storedExit, type: "market", limitPrice: undefined, marketHours: "regular_hours" };
    expect(repriceStoredProtectiveExit(regularExit, p, { price: 1 }, PRE)).toBe(regularExit);
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

  it("anchors the SELL limit to the real BID when the scan carries one (composite price is ask-biased)", () => {
    const [exit] = generateProactiveRiskProposals(positions, currentPrices, policy, {}, {}, 15, {
      MSFT: { bid: 358, ask: 360 }
    });
    expect(exit).toMatchObject({
      symbol: "MSFT",
      side: "sell",
      type: "limit",
      marketHours: "extended_hours",
      limitPrice: 357.46 // 358 * (1 - 0.0015)
    });
  });

  it("keeps a FRACTIONAL position on the market/queue-to-open exit even when a buffer is supplied", () => {
    // A fractional extended-hours limit would be hard-blocked by policy ("Fractional or dollar-based
    // orders must be regular-hours only.") — the breached stop must queue to the open, not vanish.
    const fractional = [{ symbol: "MSFT", quantity: 5.5, averageCost: 400, marketValue: 1980 }];
    const [exit] = generateProactiveRiskProposals(fractional, currentPrices, policy, {}, {}, 15);
    expect(exit).toMatchObject({
      symbol: "MSFT",
      side: "sell",
      type: "market",
      quantity: 5.5,
      marketHours: "regular_hours"
    });
    expect(exit.limitPrice).toBeUndefined();
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
