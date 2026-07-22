import { cookies } from "next/headers";
import { NextResponse } from "next/server";

// This route acts as the callback destination for Auth.js when initiated from the iOS app.
// The iOS app launches ASWebAuthenticationSession pointing to:
// /api/auth/signin/[provider]?callbackUrl=https://socratictrade.com/api/mobile/auth-redirect
//
// Once Auth.js finishes the OAuth flow, it sets the session cookie in the browser and redirects here.
// We intercept that cookie and redirect to the custom URL scheme so the iOS app can capture the JWT.
export async function GET() {
  const cookieStore = await cookies();
  
  // Auth.js uses a prefixed cookie name in production.
  const token = 
    cookieStore.get("__Secure-authjs.session-token")?.value || 
    cookieStore.get("authjs.session-token")?.value;

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=MobileAuthFailed", "https://socratictrade.com"));
  }

  // Redirect to the native app with the token
  return NextResponse.redirect(`socratictrade://auth?token=${token}`);
}
