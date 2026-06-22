// Resolve the authenticated app userId for a request.
//
// SECURITY: identity is established by `middleware.ts` (verified Cloudflare Access email today; Auth.js
// next), which forwards a trusted `x-authenticated-user-email` header and strips client-supplied hints.
// We map that verified email → a stable userId here. We NEVER trust a client-supplied `x-user-id`,
// `?userId`, or body `userId` — those were the old IDOR vectors. In production, middleware 401s any
// request that lacks a verified identity, so the dev fallback below is only reachable in dev/test.

import { DEV_USER_ID, userIdForEmail } from "./auth/identity";

/** Header set by middleware after it verifies identity. Client-supplied copies are stripped by middleware. */
export const AUTHENTICATED_EMAIL_HEADER = "x-authenticated-user-email";

/** Back-compat: the dev/test fallback identity. */
export const DEFAULT_REQUEST_USER_ID = DEV_USER_ID;

/**
 * The trusted userId for this request. `_body` is accepted for call-site compatibility but ignored — body
 * `userId` is no longer an identity source.
 */
export function resolveRequestUserId(request: Request, _body?: unknown): string {
  const email = request.headers.get(AUTHENTICATED_EMAIL_HEADER);
  if (email && email.includes("@")) return userIdForEmail(email);
  return DEV_USER_ID;
}
