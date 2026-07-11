// Resolve the authenticated app userId for a request.
//
// SECURITY: identity metadata is established by `middleware.ts`, which strips client-supplied hints
// and forwards either a verified upstream email or the explicit auth-unconfigured local fallback.
// We map that middleware-supplied email → a stable userId here. We NEVER trust a client-supplied
// `x-user-id`, `?userId`, or body `userId` — those were the old IDOR vectors. Security-sensitive role
// checks must additionally inspect middleware's identity-source provenance; see `auth/admin.ts`.

import { DEV_USER_ID, userIdForEmail } from "./auth/identity";

/** Header set by middleware after resolving identity. Client-supplied copies are stripped first. */
export const AUTHENTICATED_EMAIL_HEADER = "x-authenticated-user-email";

/** Back-compat: the dev/test fallback identity. */
export const DEFAULT_REQUEST_USER_ID = DEV_USER_ID;

export interface ResolvedRequestUser {
  userId: string;
  email?: string;
}

export function resolveRequestUserFromEmail(email: string | null): ResolvedRequestUser {
  const normalized = email?.trim().toLowerCase();
  if (normalized && normalized.includes("@")) return { userId: userIdForEmail(normalized), email: normalized };
  return { userId: DEV_USER_ID };
}

export function resolveRequestUser(request: Request): ResolvedRequestUser {
  return resolveRequestUserFromEmail(request.headers.get(AUTHENTICATED_EMAIL_HEADER));
}

/**
 * The trusted userId for this request. `_body` is accepted for call-site compatibility but ignored — body
 * `userId` is no longer an identity source.
 */
export function resolveRequestUserId(request: Request, _body?: unknown): string {
  void _body;
  return resolveRequestUser(request).userId;
}
