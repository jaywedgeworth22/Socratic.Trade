import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-oauth-${randomUUID()}.db`)}`;
});

describe("mcp oauth", () => {
  it("builds an authorization URL with PKCE parameters", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:3000/api/auth/robinhood/callback");
    const { buildMcpAuthorizationUrl } = await import("../src/lib/mcp-oauth");

    const authorizationUrl = new URL(await buildMcpAuthorizationUrl());

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://auth.example.test/authorize");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-123");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
  });

  it("normalizes token responses and preserves refresh tokens on refresh", async () => {
    const { tokenResponseToTokens } = await import("../src/lib/mcp-oauth");

    const initial = tokenResponseToTokens({ access_token: "one", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" });
    const refreshed = tokenResponseToTokens({ access_token: "two", expires_in: 3600, token_type: "Bearer" }, initial);

    expect(initial.refreshToken).toBe("refresh");
    expect(refreshed.accessToken).toBe("two");
    expect(refreshed.refreshToken).toBe("refresh");
    expect(refreshed.expiresAt).toBeTruthy();
  });
});
