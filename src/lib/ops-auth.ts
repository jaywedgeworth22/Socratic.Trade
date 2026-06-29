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

/** Accepted env secrets. Legacy admin token is only used when OPS token is unset. */
export function opsDiagnosticSecrets(): string[] {
  const ops = process.env.OPS_DIAGNOSTIC_TOKEN?.trim();
  if (ops) return [ops];
  const legacy = process.env.ADMIN_REINDEX_TOKEN?.trim();
  return legacy ? [legacy] : [];
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
