import { NextRequest, NextResponse } from "next/server";
import { completeMcpOAuthCallback } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    return new NextResponse(description ? `${error}: ${description}` : error, { status: 400 });
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return new NextResponse("Missing OAuth code or state.", { status: 400 });

  try {
    await completeMcpOAuthCallback({ code, state });
    return NextResponse.redirect(new URL("/?robinhoodMcp=connected", request.url));
  } catch (callbackError) {
    return new NextResponse(callbackError instanceof Error ? callbackError.message : "Robinhood MCP OAuth callback failed.", {
      status: 500
    });
  }
}
