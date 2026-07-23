import { audit, listConnectedAccounts } from "./db";
import { ingestLearned } from "./learned-context/store";
import { getThesisScorecard } from "./performance";

export const PAPER_TRANSFER_MIN_LOTS = 20;
export const LIVE_TRANSFER_MIN_LOTS = 5;
export const TRANSFER_MIN_ABS_SHRUNK_RETURN_PCT = 0.25;

export interface ThesisTransferEvidence {
  connectedAccountId: string;
  environment: "paper" | "live";
  thesisTag: string;
  trades: number;
  shrunkAvgReturnPct: number;
}

export interface ThesisTransferEvaluation {
  state: "insufficient" | "discordant" | "validated";
  paperLots: number;
  liveLots: number;
  paperEdgePct: number;
  liveEdgePct: number;
  direction?: "positive" | "negative";
}

function weightedEdge(rows: ThesisTransferEvidence[]): { lots: number; edge: number } {
  const lots = rows.reduce((sum, row) => sum + Math.max(0, row.trades), 0);
  if (lots === 0) return { lots: 0, edge: 0 };
  return {
    lots,
    edge: rows.reduce((sum, row) => sum + row.shrunkAvgReturnPct * Math.max(0, row.trades), 0) / lots
  };
}

/**
 * A paper result transfers only after an independently observed live result clears a smaller
 * confirmation sample, points in the same direction, and both shrunk effects clear a materiality
 * floor. This prevents a large paper sample from numerically overwhelming contradictory live data.
 */
export function evaluatePaperToLiveTransfer(rows: ThesisTransferEvidence[]): ThesisTransferEvaluation {
  const paper = weightedEdge(rows.filter((row) => row.environment === "paper"));
  const live = weightedEdge(rows.filter((row) => row.environment === "live"));
  const base = {
    paperLots: paper.lots,
    liveLots: live.lots,
    paperEdgePct: paper.edge,
    liveEdgePct: live.edge
  };
  if (paper.lots < PAPER_TRANSFER_MIN_LOTS || live.lots < LIVE_TRANSFER_MIN_LOTS) {
    return { state: "insufficient", ...base };
  }
  const paperSign = Math.sign(paper.edge);
  const liveSign = Math.sign(live.edge);
  if (
    paperSign === 0 ||
    liveSign === 0 ||
    paperSign !== liveSign ||
    Math.abs(paper.edge) < TRANSFER_MIN_ABS_SHRUNK_RETURN_PCT ||
    Math.abs(live.edge) < TRANSFER_MIN_ABS_SHRUNK_RETURN_PCT
  ) {
    return { state: "discordant", ...base };
  }
  return { state: "validated", direction: liveSign > 0 ? "positive" : "negative", ...base };
}

/**
 * Re-evaluate all per-thesis account scorecards and emit private, cross-account research only for
 * paper lessons corroborated by live outcomes. Simulated `broker='test'` accounts are excluded: they
 * exist solely as CI infrastructure and are never admissible performance evidence.
 */
export async function validatePaperToLiveThesisTransfers(userId: string): Promise<void> {
  const evidence: ThesisTransferEvidence[] = [];
  for (const account of listConnectedAccounts(userId)) {
    if (account.broker === "test" || !account.accountNumber) continue;
    for (const stat of getThesisScorecard(account.accountNumber, account.environment, {}, userId)) {
      if (!stat.thesisTag || stat.thesisTag === "Untagged" || stat.trades <= 0) continue;
      evidence.push({
        connectedAccountId: account.id,
        environment: account.environment,
        thesisTag: stat.thesisTag,
        trades: stat.trades,
        shrunkAvgReturnPct: stat.shrunkAvgReturnPct
      });
    }
  }

  const thesisTags = [...new Set(evidence.map((row) => row.thesisTag))];
  for (const thesisTag of thesisTags) {
    const evaluation = evaluatePaperToLiveTransfer(evidence.filter((row) => row.thesisTag === thesisTag));
    audit("learned_context.transfer_evaluated", { userId, thesisTag, ...evaluation }, userId);
    if (evaluation.state !== "validated") continue;

    await ingestLearned(
      userId,
      {
        kind: "pattern",
        subject: `validated_track_record:${thesisTag}`,
        value: `The "${thesisTag}" thesis has a ${evaluation.direction} realized track record corroborated across broker-paper and live accounts.`,
        source: "paper-live-transfer",
        confidence: 0.8
      },
      "autonomous",
      { learningScope: "research", transferState: "validated" }
    );
  }
}
