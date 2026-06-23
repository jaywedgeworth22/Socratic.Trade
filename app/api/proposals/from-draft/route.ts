// Bridge: promote a chat-assistant ChatDraft into the EXISTING approve -> executeProposal rail.
// POST { draft, dryRun? }. With dryRun:true it returns the policy decision + estimated notional
// WITHOUT inserting; otherwise it inserts a status:'proposed' row that the human confirms via the
// unchanged POST /api/proposals/[id]/approve. The chat module gains NO execution capability here —
// the authoritative re-evaluation still happens inside executeProposal at confirm time.

import crypto from "crypto";
import { NextResponse } from "next/server";
import { resolveRequestUserId } from "@/lib/request-user";
import {
  audit,
  dailyExecutionStats,
  findProposedIdByRunId,
  getActiveConnectedAccount,
  getPolicy,
  insertProposal,
  notionalInLastMinutes
} from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { allowedSymbolsForPolicy, evaluateTradeProposal } from "@/lib/policy";
import { emitDashboardEvent } from "@/lib/events";
import { chatDraftToProposal } from "@/lib/chat/promote-draft";
import { deriveExecutionState } from "@/lib/execution-mode";
import type { ChatDraft } from "@/lib/chat/types";
import type { ReviewedOrder } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { draft?: ChatDraft; dryRun?: boolean; userId?: unknown };
  const userId = resolveRequestUserId(request, body);

  if (!body.draft || typeof body.draft !== "object") {
    return NextResponse.json({ error: "draft is required" }, { status: 400 });
  }
  const mapped = chatDraftToProposal(body.draft);
  if (!mapped.ok) return NextResponse.json({ error: mapped.error }, { status: 400 });
  const proposal = mapped.proposal;

  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  const executionMode = executionState.mode;
  if (!policy.accountNumber) {
    return NextResponse.json({ error: "NO_ACCOUNT", reasons: ["No account is selected."] }, { status: 400 });
  }
  if (policy.systemState === "halted") {
    return NextResponse.json({ error: "HALTED", reasons: ["System is stopped — press Start to enable orders."] }, { status: 409 });
  }
  // Never trust the LLM draft: the symbol must be in the user's allowed universe.
  if (!allowedSymbolsForPolicy(policy).includes(proposal.symbol)) {
    return NextResponse.json({ error: "SYMBOL_NOT_ALLOWED", reasons: [`${proposal.symbol} is not in the allowed universe.`] }, { status: 400 });
  }

  const gateway = getBrokerGateway(policy, userId);
  let portfolio;
  let positions;
  try {
    [portfolio, positions] = await Promise.all([
      gateway.getPortfolio(policy.accountNumber),
      gateway.getEquityPositions(policy.accountNumber)
    ]);
  } catch {
    return NextResponse.json({ error: "ACCOUNT_FETCH_FAILED", reasons: ["Could not read the account."] }, { status: 502 });
  }

  let review: ReviewedOrder | undefined;
  try {
    review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
  } catch {
    review = undefined; // estimatedNotional falls back to evaluateTradeProposal's own estimate
  }

  const now = new Date();
  const daily = dailyExecutionStats(policy.accountNumber, now, userId);
  const hourly = notionalInLastMinutes(policy.accountNumber, 60, now, userId);
  // NB: this is a PREVIEW evaluation (no full market scan); the authoritative gate runs again inside
  // executeProposal at approve time against fresh data.
  const decision = evaluateTradeProposal(proposal, {
    policy,
    portfolio,
    positions,
    dailyNotionalUsed: daily.notional,
    hourlyNotionalUsed: hourly.notional,
    dailyOrderCount: daily.openingOrderCount,
    estimatedNotional: review?.estimatedNotional,
    accountCapabilities: activeAccount?.capabilities,
    isLiveExecution: executionMode === "broker/live",
    now
  });
  const estimatedNotional = review?.estimatedNotional;

  if (body.dryRun) {
    return NextResponse.json({ dryRun: true, decision, estimatedNotional, proposal });
  }

  // Commit: idempotent on the synthetic runId so one draft can't mint duplicate proposed rows.
  const runId = `chat:${body.draft.draft_id}`;
  const existing = findProposedIdByRunId(runId, userId);
  if (existing) {
    return NextResponse.json({ proposalId: existing, deduped: true, decision, estimatedNotional, proposal }, { status: 200 });
  }

  const proposalId = crypto.randomUUID();
  insertProposal({
    userId,
    id: proposalId,
    runId,
    accountNumber: policy.accountNumber,
    proposal,
    decision,
    review,
    estimatedNotional,
    status: "proposed",
    tradeThesisTag: proposal.tradeThesisTag,
    entryMarketRegime: proposal.entryMarketRegime,
    executionMode
  });
  audit("proposal_from_chat", { userId, proposalId, draftId: body.draft.draft_id, symbol: proposal.symbol, side: proposal.side }, userId);
  emitDashboardEvent({ type: "proposal", userId, at: now.toISOString(), detail: { proposalId, status: "proposed", source: "chat" } });

  return NextResponse.json({ proposalId, decision, estimatedNotional, proposal }, { status: 201 });
}
