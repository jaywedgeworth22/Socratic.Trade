import { NextRequest, NextResponse } from "next/server";
import { callRobinhoodMcpTool, robinhoodMcpDataEnabled } from "@/lib/robinhood";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

// Dev/diagnostic route: dumps the RAW output of Robinhood MCP data tools for one symbol so the
// exact field shapes (get_equity_historicals / get_equity_fundamentals) can be confirmed before
// trusting the parsers/enrichment mapping. Gated to non-production unless ADMIN_REINDEX_TOKEN matches.
function authorized(request: Request): boolean {
  const token = process.env.ADMIN_REINDEX_TOKEN;
  if (token && request.headers.get("x-admin-token") === token) return true;
  return process.env.NODE_ENV !== "production";
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not authorized in production without ADMIN_REINDEX_TOKEN." }, { status: 403 });
  }
  if (!robinhoodMcpDataEnabled()) {
    return NextResponse.json({
      ok: false,
      error: "ROBINHOOD_ADAPTER is not 'mcp'. Set ROBINHOOD_ADAPTER=mcp and connect OAuth (or set ROBINHOOD_MCP_AUTH_TOKEN) first."
    });
  }
  const userId = resolveRequestUserId(request);
  const symbol = (new URL(request.url).searchParams.get("symbol") || "AAPL").toUpperCase();
  const [historicals, fundamentals] = await Promise.allSettled([
    callRobinhoodMcpTool(userId, "get_equity_historicals", { symbols: [symbol], symbol, interval: "day", span: "5year", bounds: "regular" }),
    callRobinhoodMcpTool(userId, "get_equity_fundamentals", { symbols: [symbol] })
  ]);
  return NextResponse.json({
    ok: true,
    symbol,
    historicals: historicals.status === "fulfilled" ? historicals.value : { error: String(historicals.reason) },
    fundamentals: fundamentals.status === "fulfilled" ? fundamentals.value : { error: String(fundamentals.reason) }
  });
}
