import { NextResponse } from "next/server";
import { listAuditByKind, listConnectedAccounts, listFillEvents } from "@/lib/db";
import { getLlmUsageSummary } from "@/lib/llm-usage";
import { aggregateModelStats, normalizeBenchmarkSummaries, type ClosedLotLike } from "@/lib/model-stats";
import { calculatePnl, getRedTeamEfficacy } from "@/lib/performance";
import { resolveRequestUserId } from "@/lib/request-user";
// Static benchmark reference (2026-07-08 model benchmark run): bundled at build time so the
// endpoint has cost/latency numbers for every catalog model even with zero live traffic.
import benchmarkJson from "../../../../docs/benchmarks/2026-07-08-llm-model-benchmark.json";

export const dynamic = "force-dynamic";

// Per-(model, role) cost / latency / realized-performance stats for the Proposer/Reviewer
// model pickers (the Framework/strategy page drawers). Auth mirrors the sibling
// /api/llm-usage route: identity comes only from the middleware-verified user.
//
// Live sources (this user's data only):
//   - llm_usage rows        → calls + avg cost per call ("strategy" = green,
//                             "strategy-bear"/"red-team" = red)
//   - llm_call_latency audit events → p50 latency (step bull = green, bear = red)
//   - closed lots across ALL of the user's connected accounts, attributed to the entry
//     proposal's proposedByModel → realized win-rate / avg P&L (GREEN only).
//   - getRedTeamEfficacy(userId).byModel (user-wide, all accounts) → per-reviewer veto
//     value-add (RED only): the counterfactual outcome of the proposals each reviewer
//     vetoed. Red attribution is per-run, not per-closed-trade, so it feeds `reviewerPerf`
//     rather than the closed-trade `perf` field — see model-stats.ts.
// Benchmark source: docs/benchmarks/2026-07-08-llm-model-benchmark.json (cold p50 +
// est. cost/call), clearly separated in the payload so the UI can label live vs benchmark.
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const sinceDays = Number(url.searchParams.get("sinceDays")) || 90;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60_000).toISOString();

  const usageRows = getLlmUsageSummary({ sinceIso, userId });
  const latencyEvents = listAuditByKind("llm_call_latency", 2000, userId);

  // Closed lots across every connected account (paper + live), FIFO-replayed exactly as the
  // Results page does. No currentPrices — only REALIZED outcomes matter here.
  const closedLots: ClosedLotLike[] = [];
  for (const account of listConnectedAccounts(userId)) {
    if (!account.accountNumber) continue;
    const { closedLots: lots } = calculatePnl(listFillEvents(account.accountNumber, undefined, 500, userId), {});
    for (const lot of lots) closedLots.push({ entryModel: lot.entryModel, reviewedByModel: lot.reviewedByModel, pnl: lot.pnl, returnPct: lot.returnPct });
  }

  // Reviewer veto value-add, user-wide (omit connectedAccountId) so it aggregates across all
  // the user's accounts — matching how the Proposer's realized P&L above spans every account.
  const reviewerPerfByModel = getRedTeamEfficacy(userId, { auditLimit: 500 }).byModel;

  const stats = aggregateModelStats({
    usageRows,
    latencyEvents,
    benchmarkSummaries: normalizeBenchmarkSummaries(benchmarkJson.summaries),
    closedLots,
    reviewerPerfByModel
  });

  return NextResponse.json({
    sinceDays,
    benchmark: { runAt: benchmarkJson.runAt, source: "2026-07-08-llm-model-benchmark" },
    stats
  });
}
