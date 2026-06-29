import { timingSafeEqual } from "node:crypto";

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Accepted env secrets, in preference order. */
export function opsDiagnosticSecrets(): string[] {
  const out: string[] = [];
  for (const raw of [process.env.OPS_DIAGNOSTIC_TOKEN, process.env.ADMIN_REINDEX_TOKEN]) {
    const token = raw?.trim();
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Gate for `/api/ops/*` — token-only, no session. Accepts `x-ops-token`, legacy
 * `x-admin-token`, or `Authorization: Bearer <token>`. Uses constant-time compare.
 */
export function authorizeOpsRequest(request: Request): boolean {
  const secrets = opsDiagnosticSecrets();
  if (secrets.length === 0) return false;
  const provided =
    request.headers.get("x-ops-token")?.trim() ||
    request.headers.get("x-admin-token")?.trim() ||
    readBearerToken(request);
  if (!provided) return false;
  return secrets.some((secret) => tokensMatch(provided, secret));
}
