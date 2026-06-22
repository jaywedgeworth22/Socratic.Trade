import { NextRequest, NextResponse } from "next/server";
import { completeMcpOAuthCallback } from "@/lib/mcp-oauth";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // No user-bound session yet at callback time; key by the resolved (dev/verified) identity plus the
  // client IP so a flood of forged callbacks can't grind the token exchange.
  const clientIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown-ip";
  const limited = enforceRateLimit(`${resolveRequestUserId(request)}:${clientIp}`, "auth/robinhood/callback", RATE_LIMITS.oauth);
  if (limited) return limited;

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
