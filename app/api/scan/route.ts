import { NextResponse } from "next/server";
import { audit, getPolicy, latestAuditByKind } from "@/lib/db";
import { dynamicIndexUniversesForPolicy } from "@/lib/index-universes";
import { mergeGroupedBarData, mergeQuoteData, scanMarket } from "@/lib/market";
import { allowedSymbolsForPolicy } from "@/lib/policy";
import { getBrokerGateway } from "@/lib/broker";
import { fetchRecentGroupedBarsRest } from "@/lib/market-signals/massive";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import type { EquityPosition } from "@/lib/types";
import {
  interactiveScanKey,
  marketScanQuotesFromAudit,
  runScanSingleFlight,
  withScanDeadline
} from "@/lib/scan-singleflight";

export const dynamic = "force-dynamic";
const INTERACTIVE_SCAN_BUDGET_MS = 20_000;

// Fresh, standalone market scan for the Market Scan tab. It returns current screener,
// broker, and persisted web-signal data instead of waiting for the next strategy run.
// Slow fundamentals are reused from that run while prices refresh; deep provider work
// stays on the scheduled strategy and on-demand ticker paths. Cheap on repeat calls:
// scanMarket caches the screener (~5 min). Read-only; places nothing.
export async function GET(request: Request) {
  let userId = "local";
  try {
    userId = resolveRequestUserId(request);
    // Per-user rate limit: read-only, but each scan fans out to several data providers, so a
    // tight refresh loop can hammer upstreams. Returns 429 with Retry-After; fails open on limiter error.
    const limited = enforceRateLimit(userId, "scan", RATE_LIMITS.scan);
    if (limited) return limited;
    const policy = getPolicy(userId);
    const latestRunAudit = policy.connectedAccountId
      ? latestAuditByKind("strategy_run", userId, policy.connectedAccountId)
      : latestAuditByKind("strategy_run", userId);
    const seedEnrichment = marketScanQuotesFromAudit(latestRunAudit?.payload, latestRunAudit?.createdAt);
    const symbols = allowedSymbolsForPolicy(policy);
    const gateway = getBrokerGateway(policy, userId);
    let positions: EquityPosition[] = [];
    if (policy.accountNumber) {
      try {
        positions = await gateway.getEquityPositions(policy.accountNumber);
      } catch {
        positions = [];
      }
    }
    // Interactive scans are quote/screener refreshes, not deep-ingestion jobs. The
    // fully enriched strategy scan supplies slow facts locally, while this path avoids
    // enqueueing hundreds of paced fundamentals calls. Coalesce identical page-mount/
    // manual-refresh requests so retries cannot multiply work.
    const dynamicUniverses = dynamicIndexUniversesForPolicy(policy);
    const scanKey = interactiveScanKey({
      userId,
      accountNumber: policy.accountNumber,
      symbols,
      candidateLimit: policy.marketScanCandidateLimit,
      outlierReserve: policy.marketScanOutlierReserve,
      dynamicUniverses,
      latestRunAuditId: latestRunAudit?.id,
      scoringWeights: policy.scoringWeights,
      universeFloor: policy.universeFloor,
      positions
    });
    const base = await runScanSingleFlight(scanKey, () =>
      withScanDeadline(INTERACTIVE_SCAN_BUDGET_MS, (signal) =>
        scanMarket(symbols, positions, policy.scoringWeights, userId, dynamicUniverses, {
          candidateLimit: policy.marketScanCandidateLimit,
          outlierReserve: policy.marketScanOutlierReserve,
          universeFloor: policy.universeFloor,
          enrichmentMode: "skip",
          seedEnrichment,
          signal
        })
      )
    );
    // Merge live broker bid/ask quotes for the top candidates, matching the strategy
    // run path (mergeQuoteData) so the table's Bid/Ask and freshest prices are populated.
    let scan = base;
    if (policy.accountNumber && base.topCandidates.length > 0) {
      try {
        const quoteSymbols = Array.from(new Set(base.topCandidates.map((q) => q.symbol)));
        scan = mergeQuoteData(base, await gateway.getEquityQuotes(policy.accountNumber, quoteSymbols));
      } catch {
        scan = base;
      }
    }
    if (scan.topCandidates.length > 0) {
      try {
        const grouped = await fetchRecentGroupedBarsRest(Date.now(), userId);
        if (grouped) scan = mergeGroupedBarData(scan, grouped.bars);
      } catch {
        // VWAP is additive only; keep the scan available when the grouped feed is absent.
      }
    }
    return NextResponse.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "scan failed";
    console.warn("[api/scan] market scan failed", message);
    try {
      audit("market_scan_failed", { message }, userId);
    } catch {
      /* audit is diagnostic only */
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
