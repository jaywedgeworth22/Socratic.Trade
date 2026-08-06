import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { fetchPriceSeries, parseMarketRange } from "@/lib/market-read";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/market/prices/{symbol}?from=YYYY-MM-DD&to=YYYY-MM-DD — token-gated, read-only EOD price
// history for congress.trade (App A) cache-aside reads. Auth: the same APP_B_INGEST_TOKEN bearer
// secret as /api/admin/securities/import (middleware passes bearer requests through unauthenticated;
// verified strictly here, constant-time). Always 200 once authorized — an unknown symbol or an empty
// range returns { ticker, closes: [] } so App A only treats genuine non-200s as "try the fallback
// provider". Closes are DESCENDING by date (closes[0] = latest close). See src/lib/market-read.ts.
export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  if (!verifySecuritiesImportToken(req)) {
    audit("market_read_rejected", { reason: "token", route: "prices" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const rateLimitResp = enforceRateLimit("peer-app", "peer-read", RATE_LIMITS.peerRead);
  if (rateLimitResp) return rateLimitResp;
  const { symbol } = await params;
  const series = await fetchPriceSeries(symbol, parseMarketRange(req.url));
  return NextResponse.json(series);
}
