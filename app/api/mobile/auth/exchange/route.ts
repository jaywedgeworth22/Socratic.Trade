import { NextResponse } from "next/server";
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
  const token = consumeMobileAuthHandoff({ code: body.code, codeVerifier: body.codeVerifier });
  if (!token) {
    return NextResponse.json({ error: "Mobile authentication code is invalid or expired." }, { status: 401 });
  }

  const cookieName = process.env.NODE_ENV === "production"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
  const response = NextResponse.json({ success: true });
  response.cookies.set(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    ...(process.env.AUTH_COOKIE_DOMAIN?.trim() ? { domain: process.env.AUTH_COOKIE_DOMAIN.trim() } : {})
  });
  return response;
}
