// G2 — Encrypt Robinhood OAuth tokens at rest.
//
// setMcpOAuthTokens / getStoredMcpOAuthTokens now run the SECRET fields (accessToken/refreshToken)
// through the shared AES-256-GCM field encryption (encryptValue/decryptValue from db-api-keys).
// Asserts: (1) the raw settings row is NOT plaintext, (2) a round-trip returns the original values,
// (3) legacy plaintext rows still decrypt (the 3-part iv:tag:ct fallback in decryptValue).
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";

const ACCESS = "rh-access-token-abc123456789";
const REFRESH = "rh-refresh-token-xyz987654321";

beforeEach(() => {
  // Fresh temp DB per test; NEVER the dev data/app.db. Set a real ENCRYPTION_KEY so we exercise the
  // ENCRYPTED path (32 bytes hex). Without it db-api-keys falls back to a random memory-only key,
  // which still encrypts — but pinning it makes the "not plaintext" assertion unambiguous.
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-security-oauth-${randomUUID()}.db`)}`;
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

describe("G2: Robinhood OAuth token encryption at rest", () => {
  it("stores encrypted secret fields (raw row is not plaintext) and round-trips the originals", async () => {
    const { setMcpOAuthTokens, getStoredMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    const { getInternalSetting } = await import("../src/lib/db");

    setMcpOAuthTokens("local", { accessToken: ACCESS, refreshToken: REFRESH, tokenType: "Bearer", scope: "tools:call" });

    // The raw persisted blob must NOT contain either plaintext secret.
    const raw = getInternalSetting<Record<string, unknown>>("robinhood_mcp_oauth_token:local");
    const rawJson = JSON.stringify(raw);
    expect(rawJson).not.toContain(ACCESS);
    expect(rawJson).not.toContain(REFRESH);
    // The encrypted fields carry the iv:tag:ct envelope (3 colon-separated hex parts).
    expect(String((raw as { accessToken?: string }).accessToken).split(":").length).toBe(3);

    // Decrypt-on-read returns the originals + preserves non-secret metadata.
    const loaded = getStoredMcpOAuthTokens("local");
    expect(loaded?.accessToken).toBe(ACCESS);
    expect(loaded?.refreshToken).toBe(REFRESH);
    expect(loaded?.tokenType).toBe("Bearer");
    expect(loaded?.scope).toBe("tools:call");
  });

  it("still decrypts a LEGACY plaintext row (pre-encryption tokens keep loading)", async () => {
    const { getStoredMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    const { setInternalSetting } = await import("../src/lib/db");

    // Simulate a token row written before encryption existed: plaintext secret fields.
    setInternalSetting("robinhood_mcp_oauth_token:local", {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenType: "Bearer"
    });

    const loaded = getStoredMcpOAuthTokens("local");
    // decryptValue's non-envelope fallback returns the plaintext unchanged.
    expect(loaded?.accessToken).toBe(ACCESS);
    expect(loaded?.refreshToken).toBe(REFRESH);
    expect(loaded?.tokenType).toBe("Bearer");
  });

  it("handles an access-token-only token (no refresh) without error", async () => {
    const { setMcpOAuthTokens, getStoredMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    const { getInternalSetting } = await import("../src/lib/db");

    setMcpOAuthTokens("local", { accessToken: ACCESS, tokenType: "Bearer" });
    const raw = getInternalSetting<Record<string, unknown>>("robinhood_mcp_oauth_token:local");
    expect(JSON.stringify(raw)).not.toContain(ACCESS);
    const loaded = getStoredMcpOAuthTokens("local");
    expect(loaded?.accessToken).toBe(ACCESS);
    expect(loaded?.refreshToken).toBeUndefined();
  });
});
