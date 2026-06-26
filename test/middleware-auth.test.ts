// Middleware auth unit tests (Phase-11 M6).
//
// Tests the four critical behaviors:
//   1. authConfigured=true + no identity → FAIL CLOSED (401 for /api/*)
//      (regression test for the NODE_ENV-edge-inlining IDOR bug)
//   2. CF header present + flag on → trusted, forwarded
//   3. Auth.js session JWT → trusted
//   4. authConfigured=false → PRIMARY fallback (dev/test behavior preserved)
//   5. Forged x-user-id / x-authenticated-user-email are stripped
//
// We invoke `middleware()` directly with a mocked NextRequest — the middleware
// module re-exports `middleware` as a named export, which we import here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeSessionToken } from "../src/lib/auth/session-token";

// Dynamic import lets us re-import with fresh module state after stubbing env.
// We use `vi.resetModules()` to flush the module cache between tests that need
// different env var states.
async function loadMiddleware() {
  const mod = await import("../middleware.js");
  return mod.middleware as (req: NextRequest) => Promise<import("next/server").NextResponse>;
}

function makeRequest(path: string, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://trading.example.com${path}`, {
    headers: extraHeaders
  });
}

/** Mint a valid Auth.js-style session JWT signed with the given secret. */
async function mintSessionJwt(email: string, secret: string): Promise<string> {
  return await encodeSessionToken({
    token: { email },
    secret,
    salt: "authjs.session-token",
    maxAge: 60 * 60
  });
}

describe("middleware — fail-closed arming (Phase-11 M6)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // ── Test 1: regression — the IDOR that existed before this fix ──────────────
  it("FAIL CLOSED: authConfigured (CF flag=1) + no identity → 401 for /api/*", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("FAIL CLOSED: authConfigured (AUTH_SECRET set) + no identity → 401 for /api/*", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  it("FAIL CLOSED: redirect to /login for non-api pages when armed with no identity", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  // ── Test 2: Cloudflare Access header trusted when flag is on ────────────────
  it("CF header + flag=1 → trusted, forwarded as x-authenticated-user-email", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "verified@example.com"
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    // Next.js edge runtime prefixes forwarded request headers with "x-middleware-request-".
    expect(fwd).toBe("verified@example.com");
  });

  it("CF header NOT trusted when flag is off", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "cf-access-authenticated-user-email": "attacker@evil.example"
    });
    // authConfigured=false, so falls back to PRIMARY_EMAIL → should be 200 with primary
    const res = await middleware(req);
    expect(res.status).toBe(200);
    // The CF header should NOT be trusted — check the forwarded header is the primary
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("owner@example.com");
  });

  // ── Test 3: Auth.js session JWT → trusted ────────────────────────────────────
  it("valid Auth.js session JWT for primary user → trusted, forwarded", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "");
    const jwt = await mintSessionJwt("owner@example.com", secret);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("owner@example.com");
  });

  it("valid Auth.js session JWT for allowlisted non-primary user → trusted, forwarded", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "user@example.com");
    const jwt = await mintSessionJwt("user@example.com", secret);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("user@example.com");
  });

  it("valid Auth.js JWT for non-primary non-allowlisted user → 403 (Auth.js without CF Access)", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("ALLOWED_EMAILS", "");
    const jwt = await mintSessionJwt("stranger@example.com", secret);
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: `authjs.session-token=${jwt}`
    });
    const res = await middleware(req);
    expect(res.status).toBe(403);
  });

  it("expired or tampered Auth.js session JWT → fail closed (401)", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-bytes-long!!");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      cookie: "authjs.session-token=invalid.tampered.token"
    });
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });

  // ── Test 4: authConfigured=false → PRIMARY fallback (dev/test) ───────────────
  it("no auth env (authConfigured=false) → PRIMARY_EMAIL fallback (dev/test behavior)", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "devowner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(200);
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("devowner@example.com");
  });

  // ── Test 5: Forged identity headers are stripped ──────────────────────────────
  it("forged x-authenticated-user-email from client is stripped even in dev fallback", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/dashboard", {
      "x-authenticated-user-email": "attacker@evil.example",
      "x-user-id": "attacker-id"
    });
    const res = await middleware(req);
    expect(res.status).toBe(200);
    // The forwarded header should be the PRIMARY (override), not the attacker's value.
    const fwd = res.headers.get("x-middleware-request-x-authenticated-user-email");
    expect(fwd).toBe("owner@example.com");
  });

  it("forged x-user-id is stripped on public paths too", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/health", {
      "x-user-id": "attacker"
    });
    const res = await middleware(req);
    // Public path always passes, but the forged header must be absent.
    expect(res.status).toBe(200);
    const fwdUserId = res.headers.get("x-middleware-request-x-user-id");
    expect(fwdUserId).toBeNull();
  });

  // ── Test 6: Public paths bypass auth entirely ──────────────────────────────────
  it("public path /api/health passes with no identity and no auth configured", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/health");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("/login page is public (no redirect loop)", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/login");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("Auth.js callback path is public so Google sign-in can complete", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/auth/callback/google");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("Robinhood OAuth start is not public; it still requires a verified app user", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("AUTH_SECRET", "");
    const middleware = await loadMiddleware();
    const req = makeRequest("/api/auth/robinhood/start");
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });
});
