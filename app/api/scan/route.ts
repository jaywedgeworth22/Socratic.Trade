import { NextResponse } from "next/server";
import { getPolicy } from "@/lib/db";
import { scanMarket } from "@/lib/market";
import { allowedSymbolsForPolicy } from "@/lib/policy";
import { getRobinhoodGateway } from "@/lib/robinhood";
import type { EquityPosition } from "@/lib/types";

export const dynamic = "force-dynamic";

// Fresh, standalone market scan for the Market Scan tab — so the table reflects the
// current enriched market (fundamentals + congressional/insider overlay) instead of
// the scan captured at the last strategy run. Cheap on repeat calls: scanMarket caches
// the screener (~5 min) and per-symbol enrichment (~6 h). Read-only; places nothing.
export async function GET() {
  try {
    const policy = getPolicy();
    const symbols = allowedSymbolsForPolicy(policy);
    let positions: EquityPosition[] = [];
    if (policy.accountNumber) {
      try {
        positions = await getRobinhoodGateway().getEquityPositions(policy.accountNumber);
      } catch {
        positions = [];
      }
    }
    const scan = await scanMarket(symbols, positions, policy.scoringWeights);
    return NextResponse.json(scan);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "scan failed" }, { status: 500 });
  }
}
