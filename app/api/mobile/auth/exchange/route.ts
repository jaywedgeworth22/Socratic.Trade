import { NextResponse } from "next/server";
import { sessionTokenForCurrentCookie } from "@/lib/auth/session-cookie-names";
import { consumeMobileAuthHandoff } from "@/lib/mobile-auth-handoff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown;
    codeVerifier?: unknown;
  };
  if (typeof body.code !== "string" || typeof body.codeVerifier !== "string") {
    return NextResponse.json({ error: "Missing mobile authentication code." }, { status: 400 });
  }
  const handoff = consumeMobileAuthHandoff({ code: body.code, codeVerifier: body.codeVerifier });
  if (!handoff) {
    return NextResponse.json({ error: "Mobile authentication code is invalid or expired." }, { status: 401 });
  }

  const reissued = await sessionTokenForCurrentCookie({
    sessionToken: handoff.sessionToken,
    cookieName: handoff.cookieName,
    secret: process.env.AUTH_SECRET,
  });
  if (!reissued) {
    return NextResponse.json({ error: "Mobile authentication code is invalid or expired." }, { status: 401 });
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set(reissued.cookieName, reissued.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    ...(process.env.AUTH_COOKIE_DOMAIN?.trim() ? { domain: process.env.AUTH_COOKIE_DOMAIN.trim() } : {})
  });
  return response;
}
