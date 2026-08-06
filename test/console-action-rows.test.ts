import { describe, expect, it } from "vitest";
import { isExecutedStatus, isNotPlacedStatus, sideVerb } from "../app/console/lib/action-verbs";

// Regression guard for a real trust bug: the Home "Autonomous actions" feed used
// to render a past-tense side verb ("Bought") regardless of whether anything
// executed, so a merely-proposed or BLOCKED decision read "AAPL Bought [Blocked]"
// — falsely asserting a completed purchase. The verb must be tense-matched to
// lifecycle status: past tense ONLY when an order actually reached the broker.
describe("sideVerb — tense-matched to lifecycle status", () => {
  it("uses past tense only when the order actually executed", () => {
    expect(sideVerb("sell", "filled")).toBe("Sold");
    expect(sideVerb("cover", "executed")).toBe("Covered");
  });

  it("uses infinitive intent for anything that did NOT execute", () => {
    // The exact owner-confusing cases: proposed and blocked must NOT say "Bought".
    expect(sideVerb("buy", "proposed")).toBe("Buy");
    expect(sideVerb("buy", "blocked")).toBe("Buy");
    expect(sideVerb("buy", "planned")).toBe("Buy");
    expect(sideVerb("buy", "error")).toBe("Buy");
    expect(sideVerb("buy", "placed")).toBe("Buy");
    expect(sideVerb("sell", "pending")).toBe("Sell");
    expect(sideVerb("short", "rejected")).toBe("Short");
    expect(sideVerb("cover", "skipped")).toBe("Cover");
  });

  it("passes an unknown side through unchanged, tense notwithstanding", () => {
    expect(sideVerb("frobnicate", "filled")).toBe("frobnicate");
    expect(sideVerb("frobnicate", "proposed")).toBe("frobnicate");
  });

  it("renders a pure observation (no side) as 'Observed'", () => {
    expect(sideVerb(null, "observed")).toBe("Observed");
    expect(sideVerb(undefined, "filled")).toBe("Observed");
    expect(sideVerb("", "blocked")).toBe("Observed");
  });

  it("is case-insensitive on the status", () => {
    expect(sideVerb("buy", "FILLED")).toBe("Bought");
    expect(sideVerb("buy", "Executed")).toBe("Bought");
  });
});

describe("isExecutedStatus — only 'filled'/'executed' mean an order actually executed", () => {
  it("is true only for filled/executed", () => {
    for (const s of ["filled", "executed", "FILLED", "Executed"]) {
      expect(isExecutedStatus(s)).toBe(true);
    }
  });

  it("is false for every non-executed status", () => {
    for (const s of ["placed", "proposed", "planned", "blocked", "rejected", "error", "pending", "approved", "skipped", "observed"]) {
      expect(isExecutedStatus(s)).toBe(false);
    }
  });
});

describe("isNotPlacedStatus — terminal 'nothing reached the broker' states", () => {
  it("is true for blocked/rejected/failed/not_placed", () => {
    for (const s of ["blocked", "rejected", "failed", "not_placed", "Blocked", "REJECTED", "Not_Placed"]) {
      expect(isNotPlacedStatus(s)).toBe(true);
    }
  });

  it("is false for executed, in-flight, or uncertain states", () => {
    for (const s of ["placed", "filled", "executed", "proposed", "planned", "pending", "observed", "error"]) {
      expect(isNotPlacedStatus(s)).toBe(false);
    }
  });
});
