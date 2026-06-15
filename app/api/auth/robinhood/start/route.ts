import { NextResponse } from "next/server";
import { buildMcpAuthorizationUrl } from "@/lib/mcp-oauth";

export async function GET() {
  try {
    return NextResponse.redirect(await buildMcpAuthorizationUrl());
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Robinhood MCP OAuth start failed.", { status: 500 });
  }
}
