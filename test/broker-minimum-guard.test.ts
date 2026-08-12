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

// Root cause (oss-lessons r2, freqtrade): cancelling a partially-filled entry order can leave a
// position fragment below the broker's minimum order notional — dust the owner can't exit as a
// standalone order later. ADVISORY ONLY: describeCancelDustRisk never gates the cancel itself,
// it only surfaces the risk so the owner sees it at cancel time.
describe("describeCancelDustRisk", () => {
  it("warns on a partially-filled fractional BUY whose fill is the whole resulting position, below the floor", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    // Filled 0.005 sh @ $100 = $0.50, still below Robinhood's $1 floor; positionQuantity matches
    // filledQuantity exactly — nothing else backs the position, so this IS the dust fragment.
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.02, filledQuantity: 0.005, averagePrice: 100, symbol: "AAPL" },
      0.005,
      "robinhood"
    );
    expect(warning).toContain("AAPL");
    expect(warning).toContain("$0.50");
    expect(warning).toContain("$1.00");
  });

  it("warns on a partially-filled fractional SHORT the same way (magnitude comparison)", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    // Short positions are stored with NEGATIVE quantities.
    const warning = describeCancelDustRisk(
      { side: "short", quantity: 0.02, filledQuantity: 0.005, averagePrice: 100, symbol: "TSLA" },
      -0.005,
      "robinhood"
    );
    expect(warning).toContain("TSLA");
  });

  it("does NOT warn when scaling into an existing larger position (fill is only a slice)", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    // Held position (5 sh) is much larger than the 0.005 sh this order filled — the fill is an
    // add to an existing position, not a standalone dust fragment.
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.02, filledQuantity: 0.005, averagePrice: 100, symbol: "AAPL" },
      5,
      "robinhood"
    );
    expect(warning).toBeUndefined();
  });

  it("is a no-op for a whole-share order even with a tiny partial fill", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 5, filledQuantity: 1, averagePrice: 0.1, symbol: "PENNY" },
      1,
      "robinhood"
    );
    expect(warning).toBeUndefined();
  });

  it("is a no-op for a broker with no known minimum-notional floor", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.02, filledQuantity: 0.005, averagePrice: 100, symbol: "AAPL" },
      0.005,
      "alpaca"
    );
    expect(warning).toBeUndefined();
  });

  it("does NOT warn on exit sides (sell/cover) — cancelling an exit never creates a new fragment", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const sellWarning = describeCancelDustRisk(
      { side: "sell", quantity: 0.02, filledQuantity: 0.005, averagePrice: 100, symbol: "AAPL" },
      0.005,
      "robinhood"
    );
    expect(sellWarning).toBeUndefined();
    const coverWarning = describeCancelDustRisk(
      { side: "cover", quantity: 0.02, filledQuantity: 0.005, averagePrice: 100, symbol: "AAPL" },
      -0.005,
      "robinhood"
    );
    expect(coverWarning).toBeUndefined();
  });

  it("does not warn when nothing has filled yet", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.02, filledQuantity: 0, averagePrice: 100, symbol: "AAPL" },
      0,
      "robinhood"
    );
    expect(warning).toBeUndefined();
  });

  it("does not warn once the order is fully filled (nothing left for the cancel to interrupt)", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.005, filledQuantity: 0.005, averagePrice: 100, symbol: "AAPL" },
      0.005,
      "robinhood"
    );
    expect(warning).toBeUndefined();
  });

  it("does not warn when the resulting position quantity is unknown", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.02, filledQuantity: 0.005, averagePrice: 100, symbol: "AAPL" },
      undefined,
      "robinhood"
    );
    expect(warning).toBeUndefined();
  });

  it("does not warn when the fill notional is already above the floor", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    // Filled 0.05 sh @ $100 = $5, comfortably above Robinhood's $1 floor.
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.1, filledQuantity: 0.05, averagePrice: 100, symbol: "AAPL" },
      0.05,
      "robinhood"
    );
    expect(warning).toBeUndefined();
  });

  it("falls back to currentPrice when the broker hasn't reported an averagePrice yet", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.02, filledQuantity: 0.005, currentPrice: 100, symbol: "AAPL" },
      0.005,
      "robinhood"
    );
    expect(warning).toContain("$0.50");
  });

  it("does not warn when no price is available at all", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.02, filledQuantity: 0.005, symbol: "AAPL" },
      0.005,
      "robinhood"
    );
    expect(warning).toBeUndefined();
  });

  it("tolerates tiny float rounding between filledQuantity and positionQuantity (epsilon)", async () => {
    const { describeCancelDustRisk } = await import("../src/lib/broker-minimum-guard");
    const warning = describeCancelDustRisk(
      { side: "buy", quantity: 0.02, filledQuantity: 0.005000000001, averagePrice: 100, symbol: "AAPL" },
      0.005,
      "robinhood"
    );
    expect(warning).toContain("AAPL");
  });
});

describe("shouldAlertCancelDustRisk cooldown", () => {
  it("alerts once per (user, accountNumber, symbol) and suppresses a second call within the cooldown window", async () => {
    const { shouldAlertCancelDustRisk } = await import("../src/lib/broker-minimum-guard");

    expect(shouldAlertCancelDustRisk("dust-cooldown-user-1", "RH-ACCOUNT", "AAPL")).toBe(true);
    expect(shouldAlertCancelDustRisk("dust-cooldown-user-1", "RH-ACCOUNT", "AAPL")).toBe(false);
  });

  it("cooldown is scoped per (user, accountNumber, symbol), not global, and independent of shouldAlertBrokerMinimumOrderBlock", async () => {
    const { shouldAlertCancelDustRisk, shouldAlertBrokerMinimumOrderBlock } = await import("../src/lib/broker-minimum-guard");

    expect(shouldAlertCancelDustRisk("dust-cooldown-user-2", "RH-ACCOUNT", "AAPL")).toBe(true);
    expect(shouldAlertCancelDustRisk("dust-cooldown-user-2", "RH-ACCOUNT", "MSFT")).toBe(true);
    expect(shouldAlertCancelDustRisk("dust-cooldown-user-2", "OTHER-ACCOUNT", "AAPL")).toBe(true);
    // A separate cooldown key namespace from the sub-minimum-order-block alert — the two never
    // share a budget even for the same (user, account, symbol).
    expect(shouldAlertBrokerMinimumOrderBlock("dust-cooldown-user-2", "RH-ACCOUNT", "AAPL")).toBe(true);
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
