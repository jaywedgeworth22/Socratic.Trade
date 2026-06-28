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

    const authorizationUrl = new URL(await buildMcpAuthorizationUrl("user-a"));

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://auth.example.test/authorize");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-123");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
  });

  it("stores the state blob under a per-user key", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    const { buildMcpAuthorizationUrl, findMcpOAuthStateByRandom } = await import("../src/lib/mcp-oauth");

    const urlStr = await buildMcpAuthorizationUrl("user-a");
    const randomPart = new URL(urlStr).searchParams.get("state")!;
    const found = findMcpOAuthStateByRandom(randomPart);

    expect(found).toBeTruthy();
    expect(found!.value.userId).toBe("user-a");
    expect(found!.key).toMatch(/^robinhood_mcp_oauth_state:user-a:/);
  });

  it("isolates tokens per user — user-b cannot read user-a token", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_ID", "client-123");
    const { setMcpOAuthTokens, getMcpAccessToken } = await import("../src/lib/mcp-oauth");

    setMcpOAuthTokens("user-a", { accessToken: "tok-a", tokenType: "Bearer" });

    // user-b has no token stored
    const tokenB = await getMcpAccessToken("user-b");
    expect(tokenB).toBeUndefined();

    // user-a gets their own token
    const tokenA = await getMcpAccessToken("user-a");
    expect(tokenA).toBe("tok-a");
  });

  it("never reads the env override directly; the boot migration seeds local's token, tenants get none", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "operator-token");
    const { getMcpAccessToken, migrateLocalRobinhoodToken } = await import("../src/lib/mcp-oauth");

    // No env special-case in resolution: before migration even `local` has no token.
    expect(await getMcpAccessToken("local")).toBeUndefined();
    // The boot migration moves the legacy env override into local's stored OAuth token.
    expect(migrateLocalRobinhoodToken()).toBe(true);
    expect(await getMcpAccessToken("local")).toBe("operator-token");
    // A tenant never resolves the operator's token.
    expect(await getMcpAccessToken("user-b")).toBeUndefined();
  });

  it("clears only the calling user token on disconnect", async () => {
    const { setMcpOAuthTokens, clearMcpOAuthTokens, getMcpAccessToken } = await import("../src/lib/mcp-oauth");

    setMcpOAuthTokens("user-a", { accessToken: "tok-a", tokenType: "Bearer" });
    setMcpOAuthTokens("user-b", { accessToken: "tok-b", tokenType: "Bearer" });

    clearMcpOAuthTokens("user-a");

    expect(await getMcpAccessToken("user-a")).toBeUndefined();
    expect(await getMcpAccessToken("user-b")).toBe("tok-b");
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

  it("re-registers client dynamically if redirectUri changes", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTHORIZATION_URL", "https://auth.example.test/authorize");
    vi.stubEnv("ROBINHOOD_MCP_TOKEN_URL", "https://auth.example.test/token");
    vi.stubEnv("ROBINHOOD_MCP_CLIENT_REGISTRATION_URL", "https://auth.example.test/register");

    const { buildMcpAuthorizationUrl } = await import("../src/lib/mcp-oauth");

    // Mock global fetch for dynamic client registration
    let fetchCallCount = 0;
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url, options) => {
      if (url === "https://auth.example.test/register") {
        fetchCallCount++;
        return {
          ok: true,
          json: async () => ({
            client_id: `dynamic-client-${fetchCallCount}`,
            client_secret: "secret",
            token_endpoint_auth_method: "client_secret_post"
          })
        };
      }
      return originalFetch(url, options);
    });

    try {
      // First, register with redirectUri 1
      vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:3000/callback-1");
      const url1 = new URL(await buildMcpAuthorizationUrl("user-a"));
      expect(url1.searchParams.get("client_id")).toBe("dynamic-client-1");
      expect(url1.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback-1");
      expect(fetchCallCount).toBe(1);

      // Now build again with the SAME redirectUri, should reuse the cached client without fetching again
      const url1Reuse = new URL(await buildMcpAuthorizationUrl("user-a"));
      expect(url1Reuse.searchParams.get("client_id")).toBe("dynamic-client-1");
      expect(fetchCallCount).toBe(1);

      // Now change the redirectUri, should trigger a new registration
      vi.stubEnv("ROBINHOOD_MCP_REDIRECT_URI", "http://localhost:3000/callback-2");
      const url2 = new URL(await buildMcpAuthorizationUrl("user-a"));
      expect(url2.searchParams.get("client_id")).toBe("dynamic-client-2");
      expect(url2.searchParams.get("redirect_uri")).toBe("http://localhost:3000/callback-2");
      expect(fetchCallCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
