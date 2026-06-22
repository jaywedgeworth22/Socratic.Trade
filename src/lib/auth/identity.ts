// Multi-user identity (Q3). The app derives a per-user id from a VERIFIED email — never from a
// client-supplied hint. In production, `middleware.ts` verifies identity at the edge (Cloudflare Access
// today; Auth.js/Google next) and forwards a trusted `x-authenticated-user-email` header that this module
// maps to a stable userId. See docs/chat-multiuser-learning-design.md §2.
//
// NOTE: this module uses node `crypto` and must only be imported from the Node runtime (route handlers,
// lib), NOT from edge middleware. `middleware.ts` keeps its own crypto-free allowlist check.

import { createHash } from "crypto";

/** Dev/test fallback identity, used only when NOT in production (middleware 401s unauth prod requests). */
export const DEV_USER_ID = (process.env.DEV_USER_ID || "local").trim();

/** The primary operator's email. Their account inherits the legacy `"local"` dataset, so going multi-user
 *  needs no data migration; every other user gets an isolated id. */
export const PRIMARY_USER_EMAIL = (process.env.PRIMARY_USER_EMAIL || "mail@jays.services").trim().toLowerCase();

const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isPrimaryEmail(email: string): boolean {
  return normalizeEmail(email) === PRIMARY_USER_EMAIL;
}

/**
 * Deterministic, stable app userId for a verified email. The primary user keeps the legacy `"local"` id
 * (no migration); everyone else gets an opaque `u_<hash>` id. Invalid input falls back to the dev user
 * (only reachable in non-production — see middleware).
 */
export function userIdForEmail(email: string): string {
  const e = normalizeEmail(email);
  if (!e || !e.includes("@")) return DEV_USER_ID;
  if (e === PRIMARY_USER_EMAIL) return "local";
  return "u_" + createHash("sha256").update(e).digest("hex").slice(0, 24);
}

/**
 * Allowlist gate. The primary email is always allowed. When `ALLOWED_EMAILS` is unset the app defers to the
 * upstream gateway (Cloudflare Access already enforces an email allowlist); set `ALLOWED_EMAILS` for
 * defense-in-depth or when no gateway is in front.
 */
export function isEmailAllowed(email: string): boolean {
  const e = normalizeEmail(email);
  if (!e || !e.includes("@")) return false;
  if (e === PRIMARY_USER_EMAIL) return true;
  if (ALLOWED_EMAILS.length === 0) return true;
  return ALLOWED_EMAILS.includes(e);
}
