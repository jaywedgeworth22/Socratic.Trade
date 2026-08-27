import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createMobileAuthHandoff } from "@/lib/mobile-auth-handoff";

export const runtime = "nodejs";

// This route acts as the callback destination for Auth.js when initiated from the iOS app.
// The iOS app launches ASWebAuthenticationSession pointing to:
// /api/mobile/auth-start?provider=<provider>&callbackUrl=https://socratictrade.com/api/mobile/auth-redirect?code_challenge=...
// (older shipped builds open GET /api/auth/signin/<provider>, which middleware.ts translates
// to auth-start — Auth.js v5 only initiates OAuth on POST, so that GET alone dead-ends).
//
// Once Auth.js finishes the OAuth flow, it sets the session cookie in the browser and redirects here.
// The native callback carries an opaque, PKCE-bound one-time code only — never the session JWT.
export async function GET(request: Request) {
  const cookieStore = await cookies();
  const url = new URL(request.url);
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  // Auth.js uses a prefixed cookie name in production.
  const token = 
    cookieStore.get("__Secure-authjs.session-token")?.value || 
    cookieStore.get("authjs.session-token")?.value;

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=MobileAuthFailed", "https://socratictrade.com"));
  }

  const code = createMobileAuthHandoff({ sessionToken: token, codeChallenge });
  if (!code) {
    return NextResponse.redirect(new URL("/login?error=MobileAuthInvalidCallback", "https://socratictrade.com"));
  }
  const nativeCallback = new URL("socratictrade://auth");
  nativeCallback.searchParams.set("code", code);
  return NextResponse.redirect(nativeCallback);
}
