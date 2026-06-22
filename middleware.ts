// Edge auth gate (Q3). Runs before every non-static request. It establishes a TRUSTED identity and
// forwards it as `x-authenticated-user-email`, while stripping any client-supplied identity hints so the
// old IDOR (spoofable `x-user-id` / `?userId`) is closed. Route handlers read the trusted header via
// `resolveRequestUserId` (src/lib/request-user.ts).
//
// Identity sources (in order):
//   1. Cloudflare Access — the verified `Cf-Access-Authenticated-User-Email` header (you are behind CF
//      Access with an email allowlist + OTP; CF sets these headers and strips client-supplied copies).
//      Enable with CF_ACCESS_TRUST_EMAIL_HEADER=1.
//   2. (next slice) Auth.js / Google session.
//   3. Dev/test only (NOT production): fall back to the primary user so local work needs no gateway.
//
// This file must stay crypto-free / edge-safe — it does string-only allowlist checks and defers the
// email→userId hashing to the Node runtime (src/lib/auth/identity.ts).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { stripClientIdentityHeaders } from "./src/lib/auth/strip-identity";
import { checkSameOrigin } from "./src/lib/auth/csrf";

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
const PUBLIC_PREFIXES = ["/api/health", "/api/webhooks", "/access-denied", "/welcome"];

function isEmailAllowed(email: string): boolean {
  if (PRIMARY_SET.has(email)) return true; // primary operator + aliases
  if (ALLOWED.length === 0) return true; // defer to the upstream gateway (Cloudflare Access)
  return ALLOWED.includes(email);
}

function authenticatedEmail(req: NextRequest): string | null {
  if (process.env.CF_ACCESS_TRUST_EMAIL_HEADER === "1") {
    const email = req.headers.get("cf-access-authenticated-user-email");
    if (email && email.includes("@")) return email.trim().toLowerCase();
  }
  return null;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    // Public (no auth) — but still strip client-supplied identity headers so an external caller
    // (e.g. a webhook sender) can never hand a forged identity to a handler that reads it.
    const headers = stripClientIdentityHeaders(new Headers(req.headers));
    return NextResponse.next({ request: { headers } });
  }

  // CSRF: reject cross-site state-changing requests to /api/* (PUBLIC_PREFIXES already returned above, so
  // webhooks — which use their own shared-secret auth and carry no browser Origin — are unaffected). Uses a
  // same-origin assertion (Sec-Fetch-Site / Origin / Referer) appropriate for this app's header-based
  // identity; fail-open for non-browser callers, fail-closed only on a proven cross-origin browser request.
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

  const isProd = process.env.NODE_ENV === "production";
  const email = authenticatedEmail(req);

  let trustedEmail: string | null = null;
  if (email) {
    if (!isEmailAllowed(email)) {
      // Authenticated upstream, but not permitted in this app.
      return pathname.startsWith("/api/")
        ? new NextResponse("Forbidden", { status: 403 })
        : NextResponse.redirect(new URL("/access-denied", req.url));
    }
    trustedEmail = email;
  } else if (!isProd) {
    trustedEmail = PRIMARY_EMAIL; // dev/local convenience → primary user ("local")
  }

  if (!trustedEmail) {
    // No verified identity in production → fail closed.
    return pathname.startsWith("/api/")
      ? new NextResponse("Unauthorized", { status: 401 })
      : NextResponse.redirect(new URL("/access-denied", req.url));
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
