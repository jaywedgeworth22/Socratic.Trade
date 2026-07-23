import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewedOrder } from "../src/lib/types";

// Root cause (2026-07-08): the live Robinhood "Agentic" account (~$4-5 NAV) tried an AAPL
// concentration trim every hour; maxOrderPctOfNav sizing clamped it to ~$0.20-0.23, always under
// Robinhood's $1 minimum, so the order was placed and rejected on every single run — 11 run_failed
// alerts/day, forever. This suite covers the guard that stops that: a doomed order is skipped
// before it ever reaches the broker, and the resulting alert is cooldown-gated instead of firing
// on every run.
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-broker-min-guard-${randomUUID()}.db`)}`;
});

function baseReview(overrides: Partial<ReviewedOrder> = {}): ReviewedOrder {
  return { estimatedNotional: 500, alerts: [], raw: {}, ...overrides };
}

describe("describeBrokerMinimumOrderBlock", () => {
  it("blocks when the broker's own pre-flight already flagged a sub-minimum alertType", async () => {
    const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
    const review = baseReview({
      estimatedNotional: 0.23,
      preflightBlock: {
        alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"],
        message: "Dollar-based orders must be at least $1."
      }
    });

    const reason = describeBrokerMinimumOrderBlock(review, "robinhood", { dollarAmount: 0.23 });
    expect(reason).toContain("Dollar-based orders must be at least $1.");
  });

  it("falls back to a notional-floor check for a fractional/dollar-based order with no preflightBlock", async () => {
    const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
    const review = baseReview({ estimatedNotional: 0.2 });

    const reason = describeBrokerMinimumOrderBlock(review, "robinhood", { dollarAmount: 0.2 });
    expect(reason).toContain("$0.20");
    expect(reason).toContain("$1.00");
  });

  it("does NOT block a whole-share order even if its notional happens to be tiny", async () => {
    const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
    const review = baseReview({ estimatedNotional: 0.5 });

    // 1 whole share of a $0.50 stock — Robinhood's dollar/fractional minimum does not apply.
    const reason = describeBrokerMinimumOrderBlock(review, "robinhood", { quantity: 1 });
    expect(reason).toBeUndefined();
  });

  it("does not block a normal, well-sized trim (valid trim unaffected)", async () => {
    const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
    const review = baseReview({ estimatedNotional: 250 });

    const reason = describeBrokerMinimumOrderBlock(review, "robinhood", { dollarAmount: 250 });
    expect(reason).toBeUndefined();
  });

  it("is a no-op for a broker with no known minimum-notional floor", async () => {
    const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
    const review = baseReview({ estimatedNotional: 0.05 });

    const reason = describeBrokerMinimumOrderBlock(review, "alpaca", { dollarAmount: 0.05 });
    expect(reason).toBeUndefined();
  });

  // Root cause (2026-07-09): Robinhood permits liquidating an ENTIRE fractional position
  // regardless of its dollar value (that's how "dust" positions get cleaned up) — its own
  // order_checks pre-flight does not flag those. The guard's own defensive notional-floor
  // fallback didn't know about a position's full size, so it wrongly blocked a whole-position
  // dust sell exactly like a genuinely sub-minimum partial trim.
  describe("whole-position exit exemption", () => {
    it("does NOT block a whole-position dust SELL whose quantity matches positionQuantity", async () => {
      const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
      const review = baseReview({ estimatedNotional: 0.22 });

      const reason = describeBrokerMinimumOrderBlock(review, "robinhood", {
        quantity: 0.0031,
        side: "sell",
        positionQuantity: 0.0031
      });
      expect(reason).toBeUndefined();
    });

    it("does NOT block a whole-position dust COVER whose quantity matches positionQuantity", async () => {
      const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
      const review = baseReview({ estimatedNotional: 0.5 });

      const reason = describeBrokerMinimumOrderBlock(review, "robinhood", {
        quantity: 0.01,
        side: "cover",
        positionQuantity: 0.01
      });
      expect(reason).toBeUndefined();
    });

    it("tolerates tiny float rounding between quantity and positionQuantity (epsilon)", async () => {
      const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
      const review = baseReview({ estimatedNotional: 0.22 });

      const reason = describeBrokerMinimumOrderBlock(review, "robinhood", {
        quantity: 0.003100000001,
        side: "sell",
        positionQuantity: 0.0031
      });
      expect(reason).toBeUndefined();
    });

    it("still blocks a genuinely sub-minimum PARTIAL trim (quantity less than positionQuantity)", async () => {
      const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
      // Mirrors the root-cause scenario: a $0.22 trim out of a much larger held position.
      const review = baseReview({ estimatedNotional: 0.22 });

      const reason = describeBrokerMinimumOrderBlock(review, "robinhood", {
        quantity: 0.0031,
        side: "sell",
        positionQuantity: 5.0 // only trimming a slice of a much larger position
      });
      expect(reason).toContain("$0.22");
      expect(reason).toContain("$1.00");
    });

    it("does NOT exempt a BUY even if its quantity happens to match positionQuantity (exemption is sell/cover only)", async () => {
      const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
      const review = baseReview({ estimatedNotional: 0.22 });

      const reason = describeBrokerMinimumOrderBlock(review, "robinhood", {
        quantity: 0.0031,
        side: "buy",
        positionQuantity: 0.0031
      });
      expect(reason).toContain("$0.22");
    });

    it("does not exempt when positionQuantity is absent (existing call sites unaffected until they thread it through)", async () => {
      const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
      const review = baseReview({ estimatedNotional: 0.22 });

      const reason = describeBrokerMinimumOrderBlock(review, "robinhood", { quantity: 0.0031, side: "sell" });
      expect(reason).toContain("$0.22");
    });

    it("does not exempt a partial sell whose quantity is close to but not equal to positionQuantity (outside epsilon)", async () => {
      const { describeBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");
      const review = baseReview({ estimatedNotional: 0.22 });

      const reason = describeBrokerMinimumOrderBlock(review, "robinhood", {
        quantity: 0.003,
        side: "sell",
        positionQuantity: 0.0031
      });
      expect(reason).toContain("$0.22");
    });
  });
});

// Owner ruling (2026-07-09): below-minimum orders are BUMPED up to the broker floor by default
// ("bump"), with "skip" preserved as the off-switch. The bumped order re-runs the full policy gate
// at its bumped size at the call site, so caps still bind — these tests cover only the resolution.
describe("resolveBrokerMinimum", () => {
  it("proceeds untouched when the order is not below-minimum", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    const res = resolveBrokerMinimum(baseReview({ estimatedNotional: 250 }), "robinhood", { dollarAmount: 250 }, "bump");
    expect(res).toEqual({ action: "proceed" });
  });

  it("skip mode blocks exactly like the pre-ruling behavior", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    const res = resolveBrokerMinimum(baseReview({ estimatedNotional: 0.2 }), "robinhood", { dollarAmount: 0.2 }, "skip");
    expect(res.action).toBe("block");
    if (res.action === "block") expect(res.reason).toContain("$1.00");
  });

  it("bumps a dollar-based order to exactly the broker floor", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    const res = resolveBrokerMinimum(baseReview({ estimatedNotional: 0.22 }), "robinhood", { dollarAmount: 0.22, side: "buy" }, "bump");
    expect(res.action).toBe("bump");
    if (res.action === "bump") {
      expect(res.patch).toEqual({ dollarAmount: 1 });
      expect(res.becomesFullExit).toBe(false);
    }
  });

  it("bumps a fractional-quantity order up past the floor with drift headroom, rounded to 1e-6", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    // 0.0031 shares reviewed at $0.22 => price ~$70.9677/share. $1 floor * 1.02 headroom => ~0.014373 shares.
    const res = resolveBrokerMinimum(
      baseReview({ estimatedNotional: 0.22 }),
      "robinhood",
      { quantity: 0.0031, side: "sell", positionQuantity: 5.0 },
      "bump"
    );
    expect(res.action).toBe("bump");
    if (res.action === "bump") {
      const qty = res.patch.quantity!;
      const price = 0.22 / 0.0031;
      expect(qty * price).toBeGreaterThanOrEqual(1.02 - 1e-9); // clears floor + headroom
      expect(qty).toBeGreaterThan(0.0031);
      expect(Math.round(qty * 1e6)).toBeCloseTo(qty * 1e6, 6); // 6dp precision
      expect(res.becomesFullExit).toBe(false);
    }
  });

  it("caps a sell bump at the whole held position and marks it a full exit (dust-exit exempt)", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    // Position worth ~$0.71 total: any $1 bump exceeds it, so the sell becomes a full exit.
    const res = resolveBrokerMinimum(
      baseReview({ estimatedNotional: 0.22 }),
      "robinhood",
      { quantity: 0.0031, side: "sell", positionQuantity: 0.01 },
      "bump"
    );
    expect(res.action).toBe("bump");
    if (res.action === "bump") {
      expect(res.patch.quantity).toBe(0.01);
      expect(res.becomesFullExit).toBe(true);
    }
  });

  it("blocks (not full-exit bumps) a sell whose ORIGINAL quantity already exceeds the held position", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    // Sell 0.02 while holding only 0.01 (~$10/share => $0.20 notional, below the $1 floor).
    // Un-bumped, sellQuantityExceedsHoldings (policy.ts) would deterministically reject this as a
    // correctness error; the full-exit cap must NOT convert it into a placed full liquidation.
    const res = resolveBrokerMinimum(
      baseReview({ estimatedNotional: 0.2 }),
      "robinhood",
      { quantity: 0.02, side: "sell", positionQuantity: 0.01 },
      "bump"
    );
    expect(res.action).toBe("block");
    if (res.action === "block") {
      expect(res.reason).toContain("below the broker's");
    }
  });

  it("blocks (not bumps) when the broker's floor is unknown even if a preflight block fired", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    const review = baseReview({
      estimatedNotional: 0.5,
      preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "too small" }
    });
    const res = resolveBrokerMinimum(review, "alpaca", { dollarAmount: 0.5 }, "bump");
    expect(res.action).toBe("block");
  });

  it("blocks when there is no usable sizing basis to bump from (zero estimated notional, no dollar amount)", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    const review = baseReview({
      estimatedNotional: 0,
      preflightBlock: { alertTypes: ["EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER"], message: "sub-dollar" }
    });
    const res = resolveBrokerMinimum(review, "robinhood", { quantity: 0.001, side: "buy" }, "bump");
    expect(res.action).toBe("block");
  });

  it("never fires for a whole-position dust exit (proceed, no bump needed)", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    const res = resolveBrokerMinimum(
      baseReview({ estimatedNotional: 0.22 }),
      "robinhood",
      { quantity: 0.0031, side: "sell", positionQuantity: 0.0031 },
      "bump"
    );
    expect(res).toEqual({ action: "proceed" });
  });

  // Review finding (2026-07-09, converged across two lenses): a dollar-based dust trim of a
  // position worth LESS than the floor must not bump to a $1 sell of a $0.70 position — the policy
  // engine's holdings checks no-op on dollar orders, so nothing downstream would catch it.
  describe("dollar-based sell/cover position cap", () => {
    it("converts a dollar trim of an at/below-floor position into a full-position share exit", async () => {
      const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
      const res = resolveBrokerMinimum(
        baseReview({ estimatedNotional: 0.22 }),
        "robinhood",
        { dollarAmount: 0.22, side: "sell", positionQuantity: 0.01, positionMarketValue: 0.7 },
        "bump"
      );
      expect(res.action).toBe("bump");
      if (res.action === "bump") {
        expect(res.patch).toEqual({ quantity: 0.01 });
        expect(res.becomesFullExit).toBe(true);
      }
    });

    it("still bumps a dollar trim normally when the position comfortably exceeds the floor", async () => {
      const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
      const res = resolveBrokerMinimum(
        baseReview({ estimatedNotional: 0.22 }),
        "robinhood",
        { dollarAmount: 0.22, side: "sell", positionQuantity: 0.5, positionMarketValue: 35 },
        "bump"
      );
      expect(res.action).toBe("bump");
      if (res.action === "bump") expect(res.patch).toEqual({ dollarAmount: 1 });
    });

    it("blocks (fail-safe) a dollar sell when the position's market value is unknown", async () => {
      const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
      const res = resolveBrokerMinimum(
        baseReview({ estimatedNotional: 0.22 }),
        "robinhood",
        { dollarAmount: 0.22, side: "sell", positionQuantity: 0.01 },
        "bump"
      );
      expect(res.action).toBe("block");
    });

    it("dollar BUYs are unaffected by the position cap (no position needed to buy)", async () => {
      const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
      const res = resolveBrokerMinimum(
        baseReview({ estimatedNotional: 0.22 }),
        "robinhood",
        { dollarAmount: 0.22, side: "buy" },
        "bump"
      );
      expect(res.action).toBe("bump");
      if (res.action === "bump") expect(res.patch).toEqual({ dollarAmount: 1 });
    });
  });

  it("blocks (fail-safe) when the bump math produces no increase — broker preflight disagrees with our estimate", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    // preflightBlock fired, but our own review estimates the order ALREADY above floor+headroom:
    // the computed bump would not increase the quantity, so the guard refuses to guess and blocks.
    const review = baseReview({
      estimatedNotional: 1.5,
      preflightBlock: { alertTypes: ["EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER"], message: "sub-dollar" }
    });
    const res = resolveBrokerMinimum(review, "robinhood", { quantity: 0.02, side: "buy" }, "bump");
    expect(res.action).toBe("block");
  });

  it("bumps off the authoritative preflight signal even when the notional fallback would not fire", async () => {
    const { resolveBrokerMinimum } = await import("../src/lib/broker-minimum-guard");
    // Dollar-based order the broker flagged; our estimate is glitchy-high but the dollar branch
    // bumps to the floor regardless of the estimate.
    const review = baseReview({
      estimatedNotional: 0.99,
      preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "min $1" }
    });
    const res = resolveBrokerMinimum(review, "robinhood", { dollarAmount: 0.99, side: "buy" }, "bump");
    expect(res.action).toBe("bump");
    if (res.action === "bump") expect(res.patch).toEqual({ dollarAmount: 1 });
  });
});

describe("shouldAlertBrokerMinimumOrderBlock cooldown", () => {
  it("alerts once per (user, accountNumber, symbol) and suppresses a second call within the cooldown window", async () => {
    const { shouldAlertBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");

    expect(shouldAlertBrokerMinimumOrderBlock("cooldown-user-1", "RH-ACCOUNT", "AAPL")).toBe(true);
    // Second call for the SAME account+symbol, same "run" — must emit nothing (cooldown active).
    expect(shouldAlertBrokerMinimumOrderBlock("cooldown-user-1", "RH-ACCOUNT", "AAPL")).toBe(false);
    expect(shouldAlertBrokerMinimumOrderBlock("cooldown-user-1", "RH-ACCOUNT", "AAPL")).toBe(false);
  });

  it("cooldown is scoped per (user, accountNumber, symbol), not global", async () => {
    const { shouldAlertBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");

    expect(shouldAlertBrokerMinimumOrderBlock("cooldown-user-2", "RH-ACCOUNT", "AAPL")).toBe(true);
    // Different symbol, same account — independent cooldown.
    expect(shouldAlertBrokerMinimumOrderBlock("cooldown-user-2", "RH-ACCOUNT", "MSFT")).toBe(true);
    // Different account, same symbol — independent cooldown.
    expect(shouldAlertBrokerMinimumOrderBlock("cooldown-user-2", "OTHER-ACCOUNT", "AAPL")).toBe(true);
    // Same broker account and symbol, different owner — independent cooldown and deletion scope.
    expect(shouldAlertBrokerMinimumOrderBlock("cooldown-user-3", "RH-ACCOUNT", "AAPL")).toBe(true);
  });
});
