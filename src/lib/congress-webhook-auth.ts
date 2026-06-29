// Webhook bearer-secret verification for the congress.trade (App A) push receiver.
//
// Kept in its OWN module (imported only by the Node route handler) so the `crypto` dependency is
// never pulled into the SSE-consumer chain (congress-stream → streams/index → instrumentation),
// which Next bundles for a runtime that rejects Node built-ins. Mirrors web-sources/technical.ts.

import crypto from "crypto";

/**
 * Constant-time verify of App A's webhook bearer secret (CONGRESS_WEBHOOK_SECRET). Returns false
 * when no secret is configured (the webhook is closed by default) or the token is absent/mismatched.
 */
export function verifyCongressWebhookSecret(req: Request): boolean {
  const expected = (process.env.CONGRESS_WEBHOOK_SECRET ?? "").trim();
  if (!expected) return false; // no secret configured → reject all writes
  const header = (req.headers.get("authorization") ?? "").trim();
  const provided = /^bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return crypto.timingSafeEqual(a, b);
}
