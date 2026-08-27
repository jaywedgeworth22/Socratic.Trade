// Helpers for the native iOS GET OAuth initiator (app/api/mobile/auth-start).
// Kept out of the route file so tests can import them (Next route modules may
// only export handlers/config).

/** The one public origin this app serves (MobileAPIClient.productionBaseURL). */
export const CANONICAL_ORIGIN = "https://socratictrade.com";

/** The origin the CLIENT used, resolved from proxy headers.  Inside the Coolify
 *  container `request.url` carries the INTERNAL origin (localhost:3000 class), so
 *  clamping against it rejected every legitimate absolute callbackUrl and collapsed
 *  the mobile handoff to "/" — the sheet then landed on the signed-in website
 *  instead of returning to the app (owner-reported 2026-08-27). */
export function publicOrigin(headers: Headers): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return CANONICAL_ORIGIN;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return CANONICAL_ORIGIN;
  }
}

/** Clamp the post-login destination to a same-origin path so the initiator can
 *  never be used as an open redirector.  Accepts relative paths and absolute
 *  URLs on the request's public origin or the canonical origin. */
export function sameOriginCallback(raw: string | null, origin: string): string {
  if (!raw) return "/";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin && url.origin !== CANONICAL_ORIGIN) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}
