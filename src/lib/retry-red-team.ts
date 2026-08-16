import { audit } from "./db";
import { getActiveConnectedAccount } from "./db-api-keys";
import { getPolicy } from "./db-profiles";
import { getProposal, updatePendingProposalReprice } from "./db-proposals";
import { emitDashboardEvent } from "./events";
import { stampRedTeamResult } from "./finalized-sizing-review";
import { debateProposal } from "./red-team";
import { loadApprovalQuoteScan } from "./approval-quote-scan";
import type { PolicyDecision, TradeProposal } from "./types";

export class RetryRedTeamError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RetryRedTeamError";
    this.status = status;
  }
}

/** Re-run Red Team on a still-pending opening and persist the new verdict. */
export async function retryProposalRedTeam(
  proposalId: string,
  userId: string = "local"
): Promise<{ ok: true; proposalId: string; verdict: TradeProposal["redTeamVerdict"] }> {
  const policy = getPolicy(userId);
  const row = getProposal(proposalId, userId);
  if (!row) throw new RetryRedTeamError("Proposal not found.", 404);
  if (row.status !== "proposed") {
    throw new RetryRedTeamError(`Proposal is already ${row.status}.`, 409);
  }
  const proposal: TradeProposal = { ...row.proposal };
  if (proposal.side !== "buy" && proposal.side !== "short") {
    throw new RetryRedTeamError("Red Team only reviews risk-adding openings.", 400);
  }

  const scan = await loadApprovalQuoteScan({
    proposal,
    positions: [],
    userId,
    accountNumber: policy.accountNumber,
    connectedAccountId: policy.connectedAccountId
  });
  const quote =
    scan.quotesBySymbol[proposal.symbol] ??
    scan.topCandidates.find((candidate) => candidate.symbol === proposal.symbol);

  const result = await debateProposal(proposal, quote, userId, policy);
  stampRedTeamResult(proposal, result);

  const decision: PolicyDecision = {
    ...row.decision,
    ...(result.available
      ? { adversaryUnavailable: undefined, adversaryUnavailableReason: undefined }
      : { adversaryUnavailable: true, adversaryUnavailableReason: result.reason })
  };
  const persisted = updatePendingProposalReprice(proposalId, { proposal, decision }, userId);
  if (!persisted) {
    throw new RetryRedTeamError("Proposal is no longer pending.", 409);
  }

  audit(
    "red_team_retry",
    {
      proposalId,
      symbol: proposal.symbol,
      side: proposal.side,
      available: result.available,
      verdict: result.verdict,
      failureKind: result.failureKind,
      model: result.model
    },
    userId,
    policy.connectedAccountId ?? getActiveConnectedAccount(userId)?.id
  );
  emitDashboardEvent({ type: "proposal", userId, at: new Date().toISOString() });
  return { ok: true, proposalId, verdict: proposal.redTeamVerdict };
}
