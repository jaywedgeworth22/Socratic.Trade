import { NextRequest, NextResponse } from "next/server";
import { completeMcpOAuthCallback, resolvePublicAppOrigin } from "@/lib/mcp-oauth";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // Providers call the callback without the app session headers. If middleware did verify and
  // forward identity, keep the cross-check; otherwise bind by the one-time stored OAuth state.
  const expectedUserId = request.headers.get(AUTHENTICATED_EMAIL_HEADER) ? resolveRequestUserId(request) : undefined;
  // Production is Cloudflare-fronted, so only its overwritten connecting-IP header is a trusted
  // client address here. A direct caller can forge X-Forwarded-For; requests without the CF header
  // deliberately share one conservative fallback bucket instead of minting attacker-chosen keys.
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
  // This route is public because the OAuth provider calls it without an app session. Rate-limit on
  // the proxy-provided client IP BEFORE state lookup: `state` is attacker-controlled at this point,
  // so including it in the key lets a caller mint a fresh bucket on every request and defeats both
  // throttling and the limiter's memory bound.
  const limited = enforceRateLimit(clientIp, "auth/robinhood/callback", RATE_LIMITS.oauth);
  if (limited) return limited;

  if (error) {
    const description = url.searchParams.get("error_description");
    return new NextResponse(description ? `${error}: ${description}` : error, { status: 400 });
  }

  if (!code || !state) return new NextResponse("Missing OAuth code or state.", { status: 400 });

  try {
    await completeMcpOAuthCallback({ code, state, expectedUserId });
    return NextResponse.redirect(new URL("/console/settings?robinhoodMcp=connected", resolvePublicAppOrigin(request)));
  } catch (callbackError) {
    return new NextResponse(callbackError instanceof Error ? callbackError.message : "Robinhood MCP OAuth callback failed.", {
      status: 500
    });
  }
}
