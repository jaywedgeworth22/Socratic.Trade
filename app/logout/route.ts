import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const AUTHJS_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const returnTo = new URL("/login", url.origin).toString();
  const accessLogoutUrl =
    process.env.CF_ACCESS_TRUST_EMAIL_HEADER === "1"
      ? new URL(`/cdn-cgi/access/logout?returnTo=${encodeURIComponent(returnTo)}`, url.origin).toString()
      : returnTo;
  const response = NextResponse.redirect(accessLogoutUrl);

  for (const name of AUTHJS_COOKIE_NAMES) {
    response.cookies.delete(name);
    for (let i = 0; i < 8; i += 1) response.cookies.delete(`${name}.${i}`);
  }

  return response;
}
