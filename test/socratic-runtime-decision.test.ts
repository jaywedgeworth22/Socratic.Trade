import { describe, expect, it } from "vitest";
import { buildSocraticDecisionCase, type SocraticOverrideResolution } from "../src/lib/socratic-runtime";
import type { PolicyDecision, TradeProposal } from "../src/lib/types";

const proposal: TradeProposal = {
  symbol: "EXE",
  side: "buy",
  type: "market",
  dollarAmount: 4.6,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Value-quality setup.",
  tradeThesisTag: "Value Quality",
  entryMarketRegime: "Neutral",
  redTeamVerdict: {
    verdict: "reject",
    rejected: true,
    available: true,
    reason: "The catalyst is too weak.",
    overridden: true
  },
  autonomyOverride: {
    requested: true,
    thesis: "The valuation cushion warrants a small exploratory entry.",
    preferenceConflicts: ["red_team_veto: The catalyst is too weak."]
  }
};

function caseFor(decision: PolicyDecision, overrideResolution: SocraticOverrideResolution) {
  return buildSocraticDecisionCase({
    userId: "u1",
    runId: "run-1",
    proposalId: "proposal-1",
    proposal,
    status: decision.approved ? "placed" : "blocked",
    authority: "decide",
    decision,
    overrideResolution
  });
}

describe("Socratic Red Team dissent receipts", () => {
  it("does not call a requested override applied when a later hard gate refuses it", () => {
    const decision: PolicyDecision = { approved: false, reasons: ["Buying power is insufficient."] };
    const result = caseFor(decision, {
      requested: true,
      applied: false,
      routeToHuman: false,
      conflicts: ["red_team_veto: The catalyst is too weak."],
      hardReasons: ["Buying power is insufficient."],
      decision
    });

    expect(result.dissent[0]).toMatchObject({
      title: "Red Team rejection",
      summary: "The catalyst is too weak.",
      tone: "negative"
    });
  });

  it("calls the objection overridden only when the final resolution applied it", () => {
    const decision: PolicyDecision = {
      approved: true,
      reasons: [],
      socraticOverride: {
        applied: true,
        mode: "execute",
        conflicts: ["red_team_veto: The catalyst is too weak."],
        thesis: "The valuation cushion warrants a small exploratory entry."
      }
    };
    const result = caseFor(decision, {
      requested: true,
      applied: true,
      routeToHuman: false,
      conflicts: ["red_team_veto: The catalyst is too weak."],
      hardReasons: [],
      decision
    });

    expect(result.dissent[0]?.title).toBe("Red Team rejection (overridden)");
    expect(result.dissent[0]?.summary).toContain("trade allowed to proceed");
  });
});
