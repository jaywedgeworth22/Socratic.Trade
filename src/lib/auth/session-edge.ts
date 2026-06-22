// Edge-safe Auth.js session verifier for use in middleware.ts.
//
// next-auth itself is NOT imported here — importing it into the edge runtime can
// bloat / break the bundle. Instead we manually verify the Auth.js JWT cookie with
// `jose` (already a transitive dep of next-auth, edge-safe) and extract the email.
//
// We import from the specific `jose/jwt/verify` sub-path to avoid pulling in JWE
// (jose's full index includes JWE which uses CompressionStream — not available in
// the Next.js edge runtime and triggers a build warning if imported via the barrel).
//
// Auth.js v5 stores the session in one of two cookies:
//   - __Secure-authjs.session-token  (HTTPS / production)
//   - authjs.session-token           (HTTP / development)
//
// The JWT is signed with AUTH_SECRET (HS256 by default in Auth.js v5).

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — sub-path export; types come from the main jose package
import { jwtVerify } from "jose/jwt/verify";

/** Auth.js v5 session cookie names, in preference order. */
const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

/**
 * Extracts and verifies the Auth.js session JWT from the request cookies.
 * Returns the verified email string, or null if no valid session is present.
 *
 * Only callable when AUTH_SECRET is set (callers should check first).
 */
export async function getSessionEmail(
  cookieHeader: string | null,
  authSecret: string
): Promise<string | null> {
  if (!cookieHeader || !authSecret) return null;

  // Parse the cookie header into a name→value map.
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    cookies[name] = value;
  }

  // Find the first Auth.js session cookie that is present.
  let token: string | undefined;
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookies[name]) {
      token = cookies[name];
      break;
    }
  }
  if (!token) return null;

  try {
    const secret = new TextEncoder().encode(authSecret);
    const { payload } = await jwtVerify(token, secret);
    const email = (payload as Record<string, unknown>)["email"];
    if (typeof email === "string" && email.includes("@")) {
      return email.trim().toLowerCase();
    }
    return null;
  } catch {
    // Invalid/expired token — not a valid session.
    return null;
  }
}
