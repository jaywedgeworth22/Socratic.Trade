import { NextResponse } from "next/server";
import { getPolicy } from "@/lib/db";
import { dynamicIndexUniversesForPolicy } from "@/lib/index-universes";
import { mergeGroupedBarData, mergeQuoteData, scanMarket } from "@/lib/market";
import { allowedSymbolsForPolicy } from "@/lib/policy";
import { getBrokerGateway } from "@/lib/broker";
import { fetchRecentGroupedBarsRest } from "@/lib/market-signals/massive";
import { resolveRequestUserId } from "@/lib/request-user";
import type { EquityPosition } from "@/lib/types";

export const dynamic = "force-dynamic";

// Fresh, standalone market scan for the Market Scan tab — so the table reflects the
// current enriched market (fundamentals + congressional/insider overlay) instead of
// the scan captured at the last strategy run. Cheap on repeat calls: scanMarket caches
// the screener (~5 min) and per-symbol enrichment (~6 h). Read-only; places nothing.
export async function GET(request: Request) {
  try {
    const userId = resolveRequestUserId(request);
    const policy = getPolicy(userId);
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
    // 25 s guard — if data providers hang (Yahoo rate-limit, Massive outage, etc.) the
    // reverse-proxy would abort at ~30 s and the browser gets a misleading network error
    // instead of a real 500. Race so we return a JSON response either way.
    const base = await Promise.race([
      scanMarket(symbols, positions, policy.scoringWeights, userId, dynamicIndexUniversesForPolicy(policy), {
        candidateLimit: policy.marketScanCandidateLimit,
        outlierReserve: policy.marketScanOutlierReserve,
        universeFloor: policy.universeFloor
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Market scan timed out — data provider is slow or rate-limited")), 25_000)
      )
    ]);
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
    return NextResponse.json({ error: error instanceof Error ? error.message : "scan failed" }, { status: 500 });
  }
}
