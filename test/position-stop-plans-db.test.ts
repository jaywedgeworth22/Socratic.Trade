import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { TradeProposal } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stop-plans-${randomUUID()}.db`)}`;
});

describe("position_stop_plans persistence", () => {
  it("round-trips style/rationale/avgCost, upserts, and clears on close", async () => {
    const { getStopPlans, recordStopPlan, clearStopPlans } = await import("../src/lib/db");
    const acct = "ACCT1";

    expect(getStopPlans(acct)).toEqual({});

    recordStopPlan(acct, "NVDA", "trailing", undefined, 100);
    recordStopPlan(acct, "AAPL", "none", "high-conviction thesis, no stop desired", 200);
    expect(getStopPlans(acct)).toEqual({
      NVDA: { style: "trailing", rationale: undefined, avgCost: 100 },
      AAPL: { style: "none", rationale: "high-conviction thesis, no stop desired", avgCost: 200 }
    });

    // Upsert advances style/rationale/avgCost for the same key (no duplicate row).
    recordStopPlan(acct, "NVDA", "fixed", "reconsidered on a scale-in", 105);
    expect(getStopPlans(acct).NVDA).toEqual({ style: "fixed", rationale: "reconsidered on a scale-in", avgCost: 105 });

    expect(getStopPlans("OTHER")).toEqual({}); // scoped per account

    clearStopPlans(acct, []); // no-op
    expect(Object.keys(getStopPlans(acct))).toHaveLength(2);
    clearStopPlans(acct, ["NVDA"]);
    expect(getStopPlans(acct)).toEqual({
      AAPL: { style: "none", rationale: "high-conviction thesis, no stop desired", avgCost: 200 }
    });
  });

  it("falls back to 'default' for an unrecognized/invalid style, never throwing", async () => {
    const { getStopPlans, recordStopPlan } = await import("../src/lib/db");
    recordStopPlan("ACCT2", "MSFT", "not-a-real-style", undefined, 50);
    expect(getStopPlans("ACCT2").MSFT).toEqual({ style: "default", rationale: undefined, avgCost: 50 });
  });

  it("scopes plans per userId, not just accountNumber", async () => {
    const { getStopPlans, recordStopPlan } = await import("../src/lib/db");
    recordStopPlan("ACCT3", "TSLA", "atr", undefined, 300, "user-a");
    expect(getStopPlans("ACCT3", "user-a").TSLA).toMatchObject({ style: "atr" });
    expect(getStopPlans("ACCT3", "user-b")).toEqual({});
  });
});

describe("stop plan is committed ON FILL (an opening buy/short with a fresh stopPlan), not at proposal time", () => {
  const open = (stopPlan?: TradeProposal["stopPlan"], side: TradeProposal["side"] = "buy"): TradeProposal => ({
    symbol: "NVDA",
    side,
    type: "market",
    quantity: 4,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "opening buy",
    tradeThesisTag: "Breakout",
    entryMarketRegime: "Bull",
    ...(stopPlan ? { stopPlan } : {})
  });

  it("recordFillFromProposal persists a fresh 'trailing' plan on an opening BUY fill", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP1", source: "live", status: "filled",
      proposal: open({ style: "trailing" }),
      execution: { orderId: "o1", refId: "r1", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP1")).toEqual({ NVDA: { style: "trailing", rationale: undefined, avgCost: 100 } });
  });

  it("persists a 'none' plan with its rationale on an opening SHORT fill", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP2", source: "live", status: "filled",
      proposal: open({ style: "none", rationale: "deep value, riding through drawdown" }, "short"),
      execution: { orderId: "o2", refId: "r2", state: "filled", averagePrice: 50, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP2").NVDA).toMatchObject({ style: "none", rationale: "deep value, riding through drawdown" });
  });

  it("does NOT persist a 'default' plan (no behavior change from before this feature existed)", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP3", source: "live", status: "filled",
      proposal: open({ style: "default" }),
      execution: { orderId: "o3", refId: "r3", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP3")).toEqual({});
  });

  it("does NOT persist a stop plan for a CLOSING fill (sell/cover), even if one were somehow attached", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP4", source: "live", status: "filled",
      proposal: open({ style: "trailing" }, "sell"),
      execution: { orderId: "o4", refId: "r4", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP4")).toEqual({});
  });

  it("a fill with no stopPlan at all is a no-op (does not touch the table)", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP5", source: "live", status: "filled",
      proposal: open(undefined),
      execution: { orderId: "o5", refId: "r5", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP5")).toEqual({});
  });

  it("does NOT persist a plan while the live broker order is still 'pending_reconciliation' — a canceled/expired order must never leave a plan governing a lot that never opened (Codex review, PR #1371)", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP6", source: "live", status: "pending_reconciliation",
      proposal: open({ style: "trailing" }),
      execution: { orderId: "o6", refId: "r6", state: "new", raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP6")).toEqual({});
  });

  it("an EXPLICIT 'default' plan on a scale-in fill CLEARS an existing persisted override (the only way to ever reset a position back to the account's own precedence — Codex review, PR #1371)", async () => {
    const { getStopPlans } = await import("../src/lib/db");
    const { recordFillFromProposal } = await import("../src/lib/performance");
    recordFillFromProposal({
      accountNumber: "FILLACCT-SP7", source: "live", status: "filled",
      proposal: open({ style: "none", rationale: "initial thesis: ride it out" }),
      execution: { orderId: "o7a", refId: "r7a", state: "filled", averagePrice: 100, filledQuantity: 4, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP7").NVDA).toMatchObject({ style: "none" });

    recordFillFromProposal({
      accountNumber: "FILLACCT-SP7", source: "live", status: "filled",
      proposal: open({ style: "default" }), // a scale-in add that explicitly resets
      execution: { orderId: "o7b", refId: "r7b", state: "filled", averagePrice: 105, filledQuantity: 2, raw: {} }
    });
    expect(getStopPlans("FILLACCT-SP7")).toEqual({});
  });
});
