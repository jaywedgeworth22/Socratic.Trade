import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/approval-quote-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/approval-quote-scan")>();
  return {
    ...actual,
    loadApprovalQuoteScan: async () =>
      actual.buildApprovalQuoteScan(
        { T: { symbol: "T", price: 25.1, bid: 25.09, ask: 25.11, provider: "test-scan" } },
        []
      )
  };
});

vi.mock("../src/lib/red-team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/red-team")>();
  return {
    ...actual,
    debateProposal: async () => ({
      verdict: "approve" as const,
      rejected: false,
      available: true,
      reason: "Retried and the thesis still holds.",
      model: "test-red"
    })
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-retry-red-${randomUUID()}.db`)}`;
});

describe("retryProposalRedTeam", () => {
  it("writes a new verdict onto a still-pending opening", async () => {
    const { insertProposal, getProposal } = await import("../src/lib/db");
    const { retryProposalRedTeam } = await import("../src/lib/retry-red-team");
    const userId = `retry-red-${randomUUID()}`;
    const proposalId = `p-${randomUUID()}`;
    insertProposal({
      id: proposalId,
      runId: "r",
      accountNumber: "ACCT",
      userId,
      status: "proposed",
      estimatedNotional: 8,
      proposal: {
        symbol: "T",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 24.88,
        referencePrice: 24.88,
        timeInForce: "day",
        rationale: "test",
        tradeThesisTag: "Sector-Relative-Strength",
        entryMarketRegime: "Neutral",
        redTeamVerdict: {
          available: false,
          rejected: false,
          reason: "Red Team review errored out.",
          failureKind: "timeout",
          model: "deepseek-v4-flash"
        }
      },
      decision: { approved: true, reasons: [] }
    });

    const result = await retryProposalRedTeam(proposalId, userId);
    expect(result.ok).toBe(true);
    expect(result.verdict?.available).toBe(true);
    expect(result.verdict?.reason).toMatch(/still holds/);

    const row = getProposal(proposalId, userId);
    expect(row?.proposal.redTeamVerdict?.available).toBe(true);
    expect(row?.proposal.reviewedByModel).toBe("test-red");
  });

  it("refuses exits", async () => {
    const { insertProposal } = await import("../src/lib/db");
    const { retryProposalRedTeam, RetryRedTeamError } = await import("../src/lib/retry-red-team");
    const userId = `retry-red-exit-${randomUUID()}`;
    const proposalId = `p-${randomUUID()}`;
    insertProposal({
      id: proposalId,
      runId: "r",
      accountNumber: "ACCT",
      userId,
      status: "proposed",
      estimatedNotional: 8,
      proposal: {
        symbol: "T",
        side: "sell",
        type: "market",
        quantity: 1,
        timeInForce: "day",
        rationale: "exit",
        tradeThesisTag: "Sector-Relative-Strength",
        entryMarketRegime: "Neutral"
      },
      decision: { approved: true, reasons: [] }
    });
    await expect(retryProposalRedTeam(proposalId, userId)).rejects.toBeInstanceOf(RetryRedTeamError);
  });
});
