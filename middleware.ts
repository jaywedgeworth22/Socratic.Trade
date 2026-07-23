// Edge auth gate (Phase-11 M6). Runs before every non-static request.
//
// Identity sources (first match wins):
//   1. Cloudflare Access header `cf-access-authenticated-user-email`
//      — trusted ONLY when CF_ACCESS_TRUST_EMAIL_HEADER==="1".
//   2. Auth.js v5 session JWT cookie — verified with AUTH_SECRET via jose
//      (edge-safe; next-auth is NOT imported here to avoid edge bundle issues).
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
// /api/*, redirect to /access-denied for pages). When authConfigured=false (local dev
// / tests with no auth env) → fall back to PRIMARY_EMAIL, preserving existing behavior.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createRemoteJWKSet } from "jose/jwks/remote";
import { jwtVerify } from "jose/jwt/verify";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_SESSION_ISSUED_AT_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES,
  stripClientIdentityHeaders,
  type AuthenticatedIdentitySource
} from "./src/lib/auth/strip-identity";
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
const PUBLIC_PREFIXES = ["/api/health", "/api/webhooks", "/access-denied", "/login"];

// Auth is "configured" (armed) when at least one real identity source is active.
// This is the RELIABLE fail-closed signal — it does NOT depend on NODE_ENV.
function isAuthConfigured(): boolean {
  return process.env.CF_ACCESS_TRUST_EMAIL_HEADER === "1" || !!process.env.AUTH_SECRET;
}

function isEmailAllowed(email: string): boolean {
  if (email === PRIMARY_EMAIL) return true;
  if (ALLOWED.length === 0) return true; // defer to the upstream gateway (CF Access)
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

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    // Public (no auth) — but still strip client-supplied identity headers so a forged
    // identity can never reach a handler that reads it.
    const headers = stripClientIdentityHeaders(new Headers(req.headers));
    return withSecurityHeaders(NextResponse.next({ request: { headers } }));
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
      return withSecurityHeaders(
        new NextResponse(JSON.stringify({ ok: false, error: "Cross-site request blocked (CSRF)." }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })
      );
    }
  }

  // --- Identity resolution ---

  // Source 1: Cloudflare Access header.
  let trustedEmail: string | null = getCfEmail(req);

  // Source 2: Auth.js v5 session JWT (verified via jose, edge-safe).
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
    if (!isEmailAllowed(trustedEmail)) {
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

  // --- Authorization ---

  if (trustedEmail) {
    if (!isEmailAllowed(trustedEmail, fromCf)) {
      // Authenticated upstream, but not permitted in this app.
      return withSecurityHeaders(
        pathname.startsWith("/api/")
          ? new NextResponse("Forbidden", { status: 403 })
          : NextResponse.redirect(new URL("/access-denied", req.url))
      );
    }
  } else if (pathname.startsWith("/api/admin/") && (req.headers.has("x-admin-token") || (req.headers.get("authorization") ?? "").trim().toLowerCase().startsWith("bearer "))) {
    // Allow unauthenticated requests with an x-admin-token or bearer token to reach the admin route handlers.
    // The middleware does NOT validate the token; the route handler's `requireAdmin()` or custom auth (like verifySecuritiesImportToken) will strictly validate it.
  } else {
    // No verified identity and auth is configured (or armed) → FAIL CLOSED.
    return withSecurityHeaders(
      pathname.startsWith("/api/")
        ? new NextResponse("Unauthorized", { status: 401 })
        : NextResponse.redirect(new URL("/login", req.url))
    );
  }

  // Strip spoofable client-supplied identity hints, then forward the resolved identity + provenance.
  const headers = stripClientIdentityHeaders(new Headers(req.headers));
  headers.set("x-authenticated-user-email", trustedEmail || "");
  // Preserve provenance separately from the email. Node handlers use this trusted middleware-set
  // marker to distinguish verified identities from the auth-unconfigured local fallback.
  if (identitySource) headers.set(AUTHENTICATED_IDENTITY_SOURCE_HEADER, identitySource);
  if (sessionIssuedAt !== null) {
    headers.set(AUTHENTICATED_SESSION_ISSUED_AT_HEADER, new Date(sessionIssuedAt).toISOString());
  }
  return withSecurityHeaders(NextResponse.next({ request: { headers } }));
}

export const config = {
  // Run on everything except Next internals and static image assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)"]
};
