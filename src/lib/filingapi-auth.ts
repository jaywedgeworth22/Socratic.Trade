/**
 * FilingAPI.dev is an optional enrichment lane. A missing, invalid, or 401 key
 * must skip the lane (ROIC + SEC EDGAR cover the same fields) without failing
 * health. A later different key is tried again.
 *
 * Rejection is keyed by SHA-256 of the secret so we stop using a dead prod
 * trial key after the first 401, without storing the secret.
 */

import { createHash } from "node:crypto";

const rejectedFingerprints = new Set<string>();

export function filingApiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function isFilingApiAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function isFilingApiAuthErrorText(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return (
    /\bHTTP 401\b/i.test(errorText) ||
    /\bHTTP 403\b/i.test(errorText) ||
    /\bunauthorized\b/i.test(errorText) ||
    /\binvalid api key\b/i.test(errorText) ||
    /\binvalid_api_key\b/i.test(errorText)
  );
}

export function isFilingApiKeyRejected(apiKey: string | null | undefined): boolean {
  const key = apiKey?.trim();
  if (!key) return false;
  return rejectedFingerprints.has(filingApiKeyFingerprint(key));
}

export function markFilingApiKeyRejected(apiKey: string): void {
  const key = apiKey.trim();
  if (!key) return;
  rejectedFingerprints.add(filingApiKeyFingerprint(key));
}

export function clearFilingApiKeyRejected(apiKey: string): void {
  const key = apiKey.trim();
  if (!key) return;
  rejectedFingerprints.delete(filingApiKeyFingerprint(key));
}

/** Register / call FilingAPI only when a key is present and not known-dead. */
export function shouldUseFilingApiKey(apiKey: string | null | undefined): boolean {
  const key = apiKey?.trim();
  if (!key) return false;
  return !isFilingApiKeyRejected(key);
}

export function resetFilingApiAuthStateForTests(): void {
  rejectedFingerprints.clear();
}
