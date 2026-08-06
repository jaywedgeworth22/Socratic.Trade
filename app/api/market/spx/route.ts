import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { fetchSpxCloses, parseMarketRange } from "@/lib/market-read";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// GET /api/market/spx?from=YYYY-MM-DD&to=YYYY-MM-DD — token-gated, read-only S&P 500 benchmark series
// for congress.trade (App A) cache-aside reads. Served as SPY daily bars (the benchmark convention the
// consumer already uses). Auth: the same APP_B_INGEST_TOKEN bearer secret as
// /api/admin/securities/import (middleware passes bearer requests through; verified strictly here).
// Always 200 once authorized — no bars in range returns { closes: [] }. Closes are DESCENDING by date
// (closes[0] = latest close). See src/lib/market-read.ts.
export async function GET(req: Request) {
  if (!verifySecuritiesImportToken(req)) {
    audit("market_read_rejected", { reason: "token", route: "spx" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const rateLimitResp = enforceRateLimit("peer-app", "peer-read", RATE_LIMITS.peerRead);
  if (rateLimitResp) return rateLimitResp;
  const closes = await fetchSpxCloses(parseMarketRange(req.url));
  return NextResponse.json({ closes });
}
