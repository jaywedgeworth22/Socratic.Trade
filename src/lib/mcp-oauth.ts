import { createHash, randomBytes } from "crypto";
import { deleteInternalSetting, getInternalSetting, setInternalSetting } from "./db";

const CLIENT_SETTING = "robinhood_mcp_oauth_client";
const STATE_PREFIX = "robinhood_mcp_oauth_state:";
const TOKEN_SETTING = "robinhood_mcp_oauth_tokens";

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_post";
}

export interface McpOAuthState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  expiresAt?: string;
}

export interface McpOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl?: string;
  redirectUri: string;
  scope: string;
  clientName: string;
}

export function getMcpOAuthConfig(): McpOAuthConfig | undefined {
  const authorizationUrl = process.env.ROBINHOOD_MCP_AUTHORIZATION_URL;
  const tokenUrl = process.env.ROBINHOOD_MCP_TOKEN_URL;
  if (!authorizationUrl || !tokenUrl) return undefined;
  return {
    authorizationUrl,
    tokenUrl,
    registrationUrl: process.env.ROBINHOOD_MCP_CLIENT_REGISTRATION_URL || undefined,
    redirectUri: process.env.ROBINHOOD_MCP_REDIRECT_URI || "http://localhost:3000/api/auth/robinhood/callback",
    scope: process.env.ROBINHOOD_MCP_SCOPES || "tools:call",
    clientName: process.env.ROBINHOOD_MCP_CLIENT_NAME || "Robinhood Agentic Trading"
  };
}

export async function buildMcpAuthorizationUrl(): Promise<string> {
  const config = requireOAuthConfig();
  const client = await getOrRegisterClient(config);
  const state = base64Url(randomBytes(32));
  const codeVerifier = base64Url(randomBytes(64));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());

  setInternalSetting(`${STATE_PREFIX}${state}`, {
    state,
    codeVerifier,
    redirectUri: config.redirectUri,
    createdAt: new Date().toISOString()
  } satisfies McpOAuthState);

  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function completeMcpOAuthCallback(input: { code: string; state: string }): Promise<McpOAuthTokens> {
  const config = requireOAuthConfig();
  const stateKey = `${STATE_PREFIX}${input.state}`;
  const state = getInternalSetting<McpOAuthState>(stateKey);
  if (!state) throw new Error("Robinhood MCP OAuth state was not found or already used.");
  deleteInternalSetting(stateKey);

  const client = await getOrRegisterClient(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: state.redirectUri,
    client_id: client.clientId,
    code_verifier: state.codeVerifier
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);

  const tokens = await exchangeToken(config.tokenUrl, body);
  setMcpOAuthTokens(tokens);
  return tokens;
}

export async function getMcpAccessToken(): Promise<string | undefined> {
  if (process.env.ROBINHOOD_MCP_AUTH_TOKEN) return process.env.ROBINHOOD_MCP_AUTH_TOKEN;
  const tokens = getStoredMcpOAuthTokens();
  if (!tokens) return undefined;
  if (!isExpiring(tokens)) return tokens.accessToken;
  if (!tokens.refreshToken) return tokens.accessToken;
  return refreshMcpAccessToken(tokens);
}

export function getStoredMcpOAuthTokens(): McpOAuthTokens | undefined {
  return getInternalSetting<McpOAuthTokens>(TOKEN_SETTING);
}

export function clearMcpOAuthTokens(): void {
  deleteInternalSetting(TOKEN_SETTING);
}

export function setMcpOAuthTokens(tokens: McpOAuthTokens): void {
  setInternalSetting(TOKEN_SETTING, tokens);
}

export function tokenResponseToTokens(raw: Record<string, unknown>, existing?: McpOAuthTokens): McpOAuthTokens {
  const accessToken = String(raw.access_token ?? "");
  if (!accessToken) throw new Error("Robinhood MCP OAuth token response did not include an access token.");
  const expiresIn = Number(raw.expires_in);
  return {
    accessToken,
    refreshToken: raw.refresh_token ? String(raw.refresh_token) : existing?.refreshToken,
    tokenType: String(raw.token_type ?? existing?.tokenType ?? "Bearer"),
    scope: raw.scope ? String(raw.scope) : existing?.scope,
    expiresAt: Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined
  };
}

async function refreshMcpAccessToken(existing: McpOAuthTokens): Promise<string> {
  const config = requireOAuthConfig();
  const client = await getOrRegisterClient(config);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: existing.refreshToken ?? "",
    client_id: client.clientId
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const tokens = await exchangeToken(config.tokenUrl, body, existing);
  setMcpOAuthTokens(tokens);
  return tokens.accessToken;
}

async function getOrRegisterClient(config: McpOAuthConfig): Promise<McpOAuthClient> {
  const configuredClientId = process.env.ROBINHOOD_MCP_CLIENT_ID;
  if (configuredClientId) {
    return {
      clientId: configuredClientId,
      clientSecret: process.env.ROBINHOOD_MCP_CLIENT_SECRET || undefined,
      tokenEndpointAuthMethod: process.env.ROBINHOOD_MCP_CLIENT_SECRET ? "client_secret_post" : "none"
    };
  }

  const existing = getInternalSetting<McpOAuthClient>(CLIENT_SETTING);
  if (existing) return existing;
  if (!config.registrationUrl) {
    throw new Error("ROBINHOOD_MCP_CLIENT_ID or ROBINHOOD_MCP_CLIENT_REGISTRATION_URL is required for MCP OAuth.");
  }

  const response = await fetch(config.registrationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: config.clientName,
      redirect_uris: [config.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  if (!response.ok) throw new Error(`Robinhood MCP OAuth registration failed with HTTP ${response.status}.`);
  const raw = (await response.json()) as Record<string, unknown>;
  const client: McpOAuthClient = {
    clientId: String(raw.client_id ?? ""),
    clientSecret: raw.client_secret ? String(raw.client_secret) : undefined,
    tokenEndpointAuthMethod: raw.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none"
  };
  if (!client.clientId) throw new Error("Robinhood MCP OAuth registration did not return a client_id.");
  setInternalSetting(CLIENT_SETTING, client);
  return client;
}

async function exchangeToken(tokenUrl: string, body: URLSearchParams, existing?: McpOAuthTokens): Promise<McpOAuthTokens> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Robinhood MCP OAuth token exchange failed with HTTP ${response.status}.`);
  return tokenResponseToTokens((await response.json()) as Record<string, unknown>, existing);
}

function isExpiring(tokens: McpOAuthTokens): boolean {
  if (!tokens.expiresAt) return false;
  return new Date(tokens.expiresAt).getTime() - Date.now() < 60_000;
}

function requireOAuthConfig(): McpOAuthConfig {
  const config = getMcpOAuthConfig();
  if (!config) throw new Error("ROBINHOOD_MCP_AUTHORIZATION_URL and ROBINHOOD_MCP_TOKEN_URL are required for MCP OAuth.");
  return config;
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
