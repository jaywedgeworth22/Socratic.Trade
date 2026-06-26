// Edge auth gate (Phase-11 M6). Runs before every non-static request.
//
// Identity sources (first match wins):
//   1. Cloudflare Access header `cf-access-authenticated-user-email`
//      — trusted ONLY when CF_ACCESS_TRUST_EMAIL_HEADER==="1".
//   2. Auth.js v5 session JWT cookie — verified with the same edge-safe HS256
//      helper configured in src/lib/auth/auth.ts.
//   3. Dev/local fallback to PRIMARY_USER_EMAIL — ONLY when auth is NOT configured.
//
// Fail-closed signal ("authConfigured"):
//   authConfigured = (CF_ACCESS_TRUST_EMAIL_HEADER === "1") || !!AUTH_SECRET
//
// This deliberately does NOT use `process.env.NODE_ENV === "production"` because
// Next.js inlines NODE_ENV at BUILD time in the edge runtime — so at runtime in the
// live deployment isProd is always false, causing every request to fail OPEN to the
// primary-email fallback (the IDOR bug this rework closes).
//
// When authConfigured=true and no verified identity is found → FAIL CLOSED (401 for
// /api/*, redirect to /login for pages). When authConfigured=false (local dev
// / tests with no auth env) → fall back to PRIMARY_EMAIL, preserving existing behavior.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { stripClientIdentityHeaders } from "./src/lib/auth/strip-identity";
import { checkSameOrigin } from "./src/lib/auth/csrf";
import { getSessionEmail } from "./src/lib/auth/session-edge";

const PRIMARY_EMAIL = (process.env.PRIMARY_USER_EMAIL || "mail@jays.services").trim().toLowerCase();
// The primary operator's aliases — additional addresses that map to the same primary account. Kept in sync
// with src/lib/auth/identity.ts (which does the email→userId mapping in the Node runtime).
const PRIMARY_SET = new Set(
  [PRIMARY_EMAIL, ...(process.env.PRIMARY_USER_EMAIL_ALIASES || "").split(",")]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
const ALLOWED = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// Paths that never require a user identity.
const PUBLIC_PREFIXES = ["/api/health", "/api/webhooks", "/access-denied", "/login", "/logout", "/welcome", "/strategy"];
const AUTHJS_PUBLIC_PATHS = new Set([
  "/api/auth/csrf",
  "/api/auth/error",
  "/api/auth/providers",
  "/api/auth/session",
  "/api/auth/signin",
  "/api/auth/signout"
]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  if (AUTHJS_PUBLIC_PATHS.has(pathname)) return true;
  return pathname.startsWith("/api/auth/callback/") || pathname.startsWith("/api/auth/signin/");
}

// Auth is "configured" (armed) when at least one real identity source is active.
// This is the reliable fail-closed signal — it does not depend on NODE_ENV.
function isAuthConfigured(): boolean {
  return process.env.CF_ACCESS_TRUST_EMAIL_HEADER === "1" || !!process.env.AUTH_SECRET;
}

function isEmailAllowed(email: string, fromCf: boolean): boolean {
  if (PRIMARY_SET.has(email)) return true; // primary operator + aliases
  // Empty ALLOWED_EMAILS defers to the upstream CF Access gate ONLY when CF actually
  // provided the identity for this request. When the identity came from an Auth.js session
  // cookie (even if CF_ACCESS_TRUST_EMAIL_HEADER is configured), empty means "only the
  // primary user" — otherwise any OAuth account bypassing CF can reach the origin.
  if (ALLOWED.length === 0) return fromCf;
  return ALLOWED.includes(email);
}

/** Source 1: Cloudflare Access trusted email header. */
function getCfEmail(req: NextRequest): string | null {
  if (process.env.CF_ACCESS_TRUST_EMAIL_HEADER !== "1") return null;
  const email = req.headers.get("cf-access-authenticated-user-email");
  if (email && email.includes("@")) return email.trim().toLowerCase();
  return null;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    // Public (no auth) — but still strip client-supplied identity headers so a forged
    // identity can never reach a handler that reads it.
    const headers = stripClientIdentityHeaders(new Headers(req.headers));
    return NextResponse.next({ request: { headers } });
  }

  // CSRF: reject cross-site state-changing requests to /api/*
  // (PUBLIC_PREFIXES already returned above, so webhooks are unaffected).
  if (pathname.startsWith("/api/")) {
    const csrf = checkSameOrigin({
      method: req.method,
      url: req.url,
      secFetchSite: req.headers.get("sec-fetch-site"),
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      forwardedHost: req.headers.get("x-forwarded-host"),
      host: req.headers.get("host")
    });
    if (!csrf.ok) {
      return new NextResponse(JSON.stringify({ ok: false, error: "Cross-site request blocked (CSRF)." }), {
        status: 403,
        headers: { "content-type": "application/json" }
      });
    }
  }

  // --- Identity resolution ---

  // Track the identity source so isEmailAllowed can distinguish CF-provided identities
  // (where empty ALLOWED_EMAILS defers to CF's own allowlist) from Auth.js session
  // identities (where empty ALLOWED_EMAILS means "only the primary user").
  let trustedEmail: string | null = null;
  let fromCf = false;

  // Source 1: Cloudflare Access header.
  const cfEmail = getCfEmail(req);
  if (cfEmail) {
    trustedEmail = cfEmail;
    fromCf = true;
  }

  // Source 2: Auth.js v5 session JWT (verified with the shared edge-safe helper).
  if (!trustedEmail && process.env.AUTH_SECRET) {
    const cookieHeader = req.headers.get("cookie");
    trustedEmail = await getSessionEmail(cookieHeader, process.env.AUTH_SECRET);
  }

  // Source 3: Dev/local fallback — ONLY when auth is NOT configured.
  if (!trustedEmail && !isAuthConfigured()) {
    trustedEmail = PRIMARY_EMAIL;
  }

  // --- Authorization ---

  if (trustedEmail) {
    if (!isEmailAllowed(trustedEmail, fromCf)) {
      // Authenticated upstream, but not permitted in this app.
      return pathname.startsWith("/api/")
        ? new NextResponse("Forbidden", { status: 403 })
        : NextResponse.redirect(new URL("/access-denied", req.url));
    }
  } else {
    // No verified identity and auth is configured (or armed) → FAIL CLOSED.
    return pathname.startsWith("/api/")
      ? new NextResponse("Unauthorized", { status: 401 })
      : NextResponse.redirect(new URL("/login", req.url));
  }

  // Strip any spoofable client-supplied identity hints, then forward the VERIFIED identity.
  const headers = stripClientIdentityHeaders(new Headers(req.headers));
  headers.set("x-authenticated-user-email", trustedEmail);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Run on everything except Next internals and static image assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)"]
};
