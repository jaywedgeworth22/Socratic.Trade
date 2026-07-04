import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-socratic-${randomUUID()}.db`)}`;
});

describe("Socratic decision persistence", () => {
  it("persists decision cases, coach notes, and framework proposal status", async () => {
    const {
      appendSocraticDecisionCoachNote,
      createSocraticFrameworkProposal,
      listSocraticDecisionCases,
      listSocraticFrameworkProposals,
      updateSocraticFrameworkProposalStatus,
      upsertSocraticDecisionCase
    } = await import("../src/lib/db");

    const decisionId = upsertSocraticDecisionCase({
      userId: "u1",
      connectedAccountId: "acct-1",
      runId: "run-1",
      proposalId: "prop-1",
      accountNumber: "acct",
      symbol: "AAPL",
      side: "buy",
      status: "proposed",
      authority: "decide",
      thesis: "Mean-Reversion",
      rationale: "Forced selling looks temporary.",
      action: "BUY AAPL $1000",
      evidence: [{ kind: "policy", title: "Approved", summary: "Preference override applied.", tone: "positive" }],
      ragAttributions: [],
      dissent: []
    });

    expect(decisionId).toBe("prop-1");
    expect(listSocraticDecisionCases("u1", { connectedAccountId: "acct-1" })[0]?.symbol).toBe("AAPL");

    const coached = appendSocraticDecisionCoachNote(decisionId, "Favor broader crash baskets next time.", "u1");
    expect(coached?.coachNotes).toEqual(["Favor broader crash baskets next time."]);

    const frameworkId = createSocraticFrameworkProposal({
      userId: "u1",
      connectedAccountId: "acct-1",
      decisionId,
      runId: "run-1",
      subsystem: "sizing",
      priority: "high",
      title: "Raise panic-basket sizing",
      rationale: "Override succeeded in a liquidity crash.",
      proposedChange: "When breadth panic reverses, allow larger basket deployment.",
      evidence: []
    });

    expect(listSocraticFrameworkProposals("u1", { connectedAccountId: "acct-1" })[0]?.id).toBe(frameworkId);
    const updated = updateSocraticFrameworkProposalStatus(frameworkId, "accepted", "u1", "Use this in next flash-crash run.");
    expect(updated?.status).toBe("accepted");
    expect(updated?.ownerResponse).toContain("flash-crash");
  });
});
