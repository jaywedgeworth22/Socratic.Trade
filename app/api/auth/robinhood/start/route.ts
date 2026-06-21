import { NextRequest, NextResponse } from "next/server";
import { buildMcpAuthorizationUrl } from "@/lib/mcp-oauth";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const userId = resolveRequestUserId(request);
    return NextResponse.redirect(await buildMcpAuthorizationUrl(userId));
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Robinhood MCP OAuth start failed.", { status: 500 });
  }
}
