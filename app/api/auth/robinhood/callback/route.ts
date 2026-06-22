import { NextRequest, NextResponse } from "next/server";
import { completeMcpOAuthCallback } from "@/lib/mcp-oauth";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // Identity of the session completing the callback. In production middleware verifies it
  // (Cloudflare Access today); in dev/single-operator it resolves to 'local'. Used both to key
  // the rate limiter and to assert the token is bound under the userId that initiated the flow.
  const sessionUserId = resolveRequestUserId(request);
  const clientIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown-ip";
  const limited = enforceRateLimit(`${sessionUserId}:${clientIp}`, "auth/robinhood/callback", RATE_LIMITS.oauth);
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
    await completeMcpOAuthCallback({ code, state, expectedUserId: sessionUserId });
    return NextResponse.redirect(new URL("/?robinhoodMcp=connected", request.url));
  } catch (callbackError) {
    return new NextResponse(callbackError instanceof Error ? callbackError.message : "Robinhood MCP OAuth callback failed.", {
      status: 500
    });
  }
}
