// Admin-role gate for admin/dev-only routes (Node runtime).
//
// The app has no first-class "role" concept yet, so admin is an EMAIL ALLOWLIST: `ADMIN_USER_EMAILS`
// (comma-separated). Identity is the trusted `x-authenticated-user-email` header that `middleware.ts` sets
// after verifying the upstream login — we never trust a client-supplied identity here (same rule as
// `resolveRequestUserId`).
//
// Default DENY: when `ADMIN_USER_EMAILS` is unset/empty, no email qualifies as admin. The primary operator
// is always admin (they own the deployment) so a misconfigured allowlist can't lock the owner out.
//
// Back-compat: the existing admin routes also accept a static `ADMIN_REINDEX_TOKEN` via the `x-admin-token`
// header and run open outside production. `requireAdmin` composes WITH that: pass `allowToken`/`allowNonProd`
// (both default true) so the email allowlist is an ADDITIONAL way in, not a regression of the prior gate.

import { AUTHENTICATED_EMAIL_HEADER } from "../request-user";

function adminEmails(): string[] {
  return (process.env.ADMIN_USER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** The primary operator's email, read fresh from env so deployment config (and tests) take effect. */
function primaryEmail(): string {
  return (process.env.PRIMARY_USER_EMAIL || "mail@jays.services").trim().toLowerCase();
}

/** True if `email` is configured as an admin (or is the primary operator). */
export function isAdminEmail(email: string | null | undefined): boolean {
  const e = (email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  if (e === primaryEmail()) return true;
  return adminEmails().includes(e);
}

export interface RequireAdminOptions {
  /** Allow the legacy `x-admin-token` === `ADMIN_REINDEX_TOKEN` bypass. Default true. */
  allowToken?: boolean;
  /** Allow non-production to run open (preserves existing dev/ops ergonomics). Default true. */
  allowNonProd?: boolean;
}

export interface AdminCheck {
  ok: boolean;
  /** Machine reason for logging/tests. */
  reason: string;
  /** The verified admin email when `ok` via the allowlist (null for token/non-prod paths). */
  email: string | null;
}

/**
 * Decide whether a request may access an admin/dev route. Order of acceptance:
 *   1. verified admin email (ADMIN_USER_EMAILS allowlist or primary operator),
 *   2. legacy `x-admin-token` matching `ADMIN_REINDEX_TOKEN` (if `allowToken`),
 *   3. non-production (if `allowNonProd`).
 * Otherwise denied → callers should return 403.
 */
export function checkAdmin(request: Request, options: RequireAdminOptions = {}): AdminCheck {
  const { allowToken = true, allowNonProd = true } = options;

  const email = request.headers.get(AUTHENTICATED_EMAIL_HEADER);
  if (isAdminEmail(email)) return { ok: true, reason: "admin-email", email: (email || "").trim().toLowerCase() };

  if (allowToken) {
    const token = process.env.ADMIN_REINDEX_TOKEN;
    if (token && request.headers.get("x-admin-token") === token) {
      return { ok: true, reason: "admin-token", email: null };
    }
  }

  if (allowNonProd && process.env.NODE_ENV !== "production") {
    return { ok: true, reason: "non-prod", email: null };
  }

  return { ok: false, reason: "forbidden", email: null };
}

/**
 * Route-handler guard: returns a ready-to-send 403 `Response` when the caller is not an admin, or `null`
 * to proceed. Mirrors the shape the existing admin routes already return.
 */
export function requireAdmin(request: Request, options: RequireAdminOptions = {}): Response | null {
  const result = checkAdmin(request, options);
  if (result.ok) return null;
  return new Response(JSON.stringify({ ok: false, error: "Forbidden: admin access required." }), {
    status: 403,
    headers: { "content-type": "application/json" }
  });
}
