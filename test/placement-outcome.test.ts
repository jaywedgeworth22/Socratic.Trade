import { describe, expect, it } from "vitest";
import {
  classifyPlacementOutcomeKind,
  isRetryableBrokerHttpError,
  isTerminalBrokerHttpError,
  mobileCommandStatusForPlacement,
  placementCommandErrorMessage,
  resolvePlacementOutcome
} from "../src/lib/placement-outcome";

describe("placement outcome resolver", () => {
  it("classifies placed outcomes", () => {
    for (const status of ["filled", "placed", "paper"]) {
      expect(classifyPlacementOutcomeKind(status)).toBe("placed");
    }
  });

  it("classifies blocked, busy, and retryable statuses", () => {
    expect(classifyPlacementOutcomeKind("blocked")).toBe("blocked");
    expect(classifyPlacementOutcomeKind("busy")).toBe("busy");
    expect(classifyPlacementOutcomeKind("not_placed")).toBe("retryable");
  });

  it("classifies error strings by whether the order can be retried", () => {
    expect(classifyPlacementOutcomeKind("error", ["Order not placed (safe to retry): timeout"])).toBe("retryable");
    expect(classifyPlacementOutcomeKind("error", ["Broker declined the order (state: rejected)."])).toBe("rejected");
    expect(classifyPlacementOutcomeKind("proposed", ["Red rejected the final size"])).toBe("rejected");
  });

  it("treats HTTP 429 and 408 as retryable broker errors, not terminal 4xx", () => {
    expect(isRetryableBrokerHttpError("Alpaca order failed: HTTP 429 Too Many Requests")).toBe(true);
    expect(isRetryableBrokerHttpError("Broker HTTP 408 while placing")).toBe(true);
    expect(isTerminalBrokerHttpError("Alpaca order failed: HTTP 429 Too Many Requests")).toBe(false);
    expect(isTerminalBrokerHttpError("Broker HTTP 403 Forbidden")).toBe(true);
    expect(isTerminalBrokerHttpError("HTTP 400 Bad Request")).toBe(true);
    expect(isRetryableBrokerHttpError("HTTP 403 Forbidden")).toBe(false);
  });

  it("resolvePlacementOutcome preserves the executeProposal payload and adds outcome", () => {
    const resolved = resolvePlacementOutcome({
      status: "busy",
      reasons: ["A strategy run is in progress; try again in a moment."]
    });
    expect(resolved).toMatchObject({
      status: "busy",
      outcome: "busy",
      reasons: ["A strategy run is in progress; try again in a moment."]
    });
  });

  it("maps placement outcomes to honest mobile command statuses", () => {
    expect(mobileCommandStatusForPlacement("placed")).toBe("succeeded");
    expect(mobileCommandStatusForPlacement("blocked")).toBe("failed");
    expect(mobileCommandStatusForPlacement("busy")).toBe("failed");
    expect(mobileCommandStatusForPlacement("retryable")).toBe("failed");
    expect(mobileCommandStatusForPlacement("rejected")).toBe("failed");
  });

  it("builds command error text from reasons when placement did not succeed", () => {
    const blocked = resolvePlacementOutcome({ status: "blocked", reasons: ["Symbol is not tradable."] });
    expect(placementCommandErrorMessage(blocked)).toBe("Symbol is not tradable.");
    const placed = resolvePlacementOutcome({ status: "placed", orderId: "ord-1" });
    expect(placementCommandErrorMessage(placed)).toBeUndefined();
  });
});
