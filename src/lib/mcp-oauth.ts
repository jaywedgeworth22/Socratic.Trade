import { deleteInternalSetting, findInternalSettingByKeyLike, getDb, getInternalSetting, setInternalSetting } from "./db";

// CLIENT registration is global (one OAuth app client shared across users).
const CLIENT_SETTING = "robinhood_mcp_oauth_client";
export const ROBINHOOD_MCP_CALLBACK_PATH = "/api/auth/robinhood/callback";
const LOCAL_DEFAULT_REDIRECT_URI = `http://localhost:3000${ROBINHOOD_MCP_CALLBACK_PATH}`;
const PUBLIC_SITE_FALLBACK_ORIGIN = "https://trading.jays.services";

// Per-user key builders.  The state key embeds the random part last so LIKE
// queries can scan by prefix without exposing userId in the OAuth redirect URL.
//   token:  robinhood_mcp_oauth_token:<userId>
//   state:  robinhood_mcp_oauth_state:<userId>:<randomPart>
function tokenSettingKey(userId: string): string {
  return `robinhood_mcp_oauth_token:${userId}`;
}
function stateSettingKey(userId: string, randomPart: string): string {
  return `robinhood_mcp_oauth_state:${userId}:${randomPart}`;
}

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_post";
  redirectUri?: string;
}

export interface McpOAuthState {
  state: string;
  userId: string;
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

export interface McpOAuthConfigOptions {
  redirectUri?: string;
}

export interface BuildMcpAuthorizationUrlOptions {
  redirectUri?: string;
}

export function getMcpOAuthConfig(options: McpOAuthConfigOptions = {}): McpOAuthConfig | undefined {
  const authorizationUrl = process.env.ROBINHOOD_MCP_AUTHORIZATION_URL;
  const tokenUrl = process.env.ROBINHOOD_MCP_TOKEN_URL;
  if (!authorizationUrl || !tokenUrl) return undefined;
  return {
    authorizationUrl,
    tokenUrl,
    registrationUrl: process.env.ROBINHOOD_MCP_CLIENT_REGISTRATION_URL || undefined,
    redirectUri: options.redirectUri || process.env.ROBINHOOD_MCP_REDIRECT_URI || LOCAL_DEFAULT_REDIRECT_URI,
    scope: process.env.ROBINHOOD_MCP_SCOPES || "tools:call",
    clientName: process.env.ROBINHOOD_MCP_CLIENT_NAME || "Agentic Trading"
  };
}

export function resolveMcpOAuthRedirectUri(request: Request): string {
  const configured = process.env.ROBINHOOD_MCP_REDIRECT_URI?.trim();
  const requestRedirectUri = new URL(ROBINHOOD_MCP_CALLBACK_PATH, resolvePublicAppOrigin(request)).toString();
  if (!configured) return requestRedirectUri;
  if (isLoopbackUrl(configured) && !isLoopbackUrl(requestRedirectUri)) return requestRedirectUri;
  return configured;
}

export function resolvePublicAppOrigin(request: Request): string {
  const requestOrigin = resolveRequestOrigin(request);
  if (!isLoopbackUrl(requestOrigin)) return requestOrigin;

  const configuredPublicOrigin =
    normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL) ||
    normalizeOrigin(process.env.AUTH_URL) ||
    normalizeOrigin(process.env.NEXTAUTH_URL);
  if (configuredPublicOrigin && !isLoopbackUrl(configuredPublicOrigin)) return configuredPublicOrigin;

  if (process.env.NODE_ENV === "production") return PUBLIC_SITE_FALLBACK_ORIGIN;
  return requestOrigin;
}

export async function buildMcpAuthorizationUrl(userId: string, options: BuildMcpAuthorizationUrlOptions = {}): Promise<string> {
  const config = requireOAuthConfig(options);
  const client = await getOrRegisterClient(config);
  const randomPart = randomBase64Url(32);
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = await sha256Base64Url(codeVerifier);

  setInternalSetting(stateSettingKey(userId, randomPart), {
    state: randomPart,
    userId,
    codeVerifier,
    redirectUri: config.redirectUri,
    createdAt: new Date().toISOString()
  } satisfies McpOAuthState);

  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", randomPart);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * Recover a stored McpOAuthState by scanning for a settings row whose key
 * matches `robinhood_mcp_oauth_state:%:<randomPart>`.  The callback route
 * receives only `state` (the random part) with no session context, so we
 * scan by the random suffix which has 32 bytes of entropy.
 */
export function findMcpOAuthStateByRandom(randomPart: string): { key: string; value: McpOAuthState } | undefined {
  return findInternalSettingByKeyLike<McpOAuthState>(`robinhood_mcp_oauth_state:%:${randomPart}`);
}

export async function completeMcpOAuthCallback(input: {
  code: string;
  state: string;
  /**
   * The userId resolved from the browser session that hit the callback. When provided, it
   * must match the userId the flow was initiated under (`stateBlob.userId`). This stops an
   * attacker-initiated flow (state bound to the attacker) from being completed in a victim's
   * session — i.e. binding a freshly-minted broker token under the wrong userId. OAuth
   * provider callbacks may arrive without app-session identity, so callers can omit this
   * and bind by the one-time server-side state row alone.
   */
  expectedUserId?: string;
}): Promise<McpOAuthTokens> {
  const config = requireOAuthConfig();

  // Recover the state blob by scanning on the random suffix — the redirect carries only the
  // random `state`, not the userId (the userId is never placed in the OAuth redirect URL).
  const found = findMcpOAuthStateByRandom(input.state);
  if (!found) throw new Error("Robinhood MCP OAuth state was not found or already used.");
  const { key: stateKey, value: stateBlob } = found;
  deleteInternalSetting(stateKey);

  // Cross-check the completing session against the initiating session. The state row is
  // consumed above regardless, so a mismatched attempt can't be retried with the same state.
  if (input.expectedUserId !== undefined && input.expectedUserId !== stateBlob.userId) {
    throw new Error("Robinhood MCP OAuth state does not belong to the current session.");
  }

  const client = await getOrRegisterClient(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: stateBlob.redirectUri,
    client_id: client.clientId,
    code_verifier: stateBlob.codeVerifier
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);

  const tokens = await exchangeToken(config.tokenUrl, body);
  setMcpOAuthTokens(stateBlob.userId, tokens);
  return tokens;
}

/**
 * Get the access token for a specific user — always from that user's own stored OAuth token.
 *
 * There is no env-token special case: the legacy `ROBINHOOD_MCP_AUTH_TOKEN` env override is
 * migrated into the `local` operator's stored token at boot (migrateLocalRobinhoodToken), so the
 * primary user resolves it like any other user and a non-`local` tenant can never reach it.
 */
export async function getMcpAccessToken(userId: string): Promise<string | undefined> {
  const tokens = getStoredMcpOAuthTokens(userId);
  if (!tokens) return undefined;
  if (!isExpiring(tokens)) return tokens.accessToken;
  if (!tokens.refreshToken) return tokens.accessToken;
  return refreshMcpAccessToken(userId, tokens);
}

/**
 * Boot migration: seed the `local` operator's stored OAuth token from the legacy
 * `ROBINHOOD_MCP_AUTH_TOKEN` env override, so broker-token resolution is uniformly per-user (no
 * special env branch). Idempotent — only seeds when `local` has no stored token yet.
 */
export function migrateLocalRobinhoodToken(): boolean {
  const env = process.env.ROBINHOOD_MCP_AUTH_TOKEN?.trim();
  if (!env) return false;
  if (getStoredMcpOAuthTokens("local")) return false;
  setMcpOAuthTokens("local", { accessToken: env, tokenType: "Bearer" });
  return true;
}

export function getStoredMcpOAuthTokens(userId: string): McpOAuthTokens | undefined {
  return getInternalSetting<McpOAuthTokens>(tokenSettingKey(userId));
}

export function clearMcpOAuthTokens(userId: string): void {
  deleteInternalSetting(tokenSettingKey(userId));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function clearMcpOAuthForUser(userId: string): { tokenDeleted: number; stateDeleted: number } {
  const db = getDb();
  const tokenDeleted = db.prepare("DELETE FROM settings WHERE key = ?").run(tokenSettingKey(userId)).changes;
  const stateDeleted = db
    .prepare("DELETE FROM settings WHERE key LIKE ? ESCAPE '\\'")
    .run(`robinhood_mcp_oauth_state:${escapeLike(userId)}:%`).changes;
  return { tokenDeleted, stateDeleted };
}

export function setMcpOAuthTokens(userId: string, tokens: McpOAuthTokens): void {
  setInternalSetting(tokenSettingKey(userId), tokens);
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

async function refreshMcpAccessToken(userId: string, existing: McpOAuthTokens): Promise<string> {
  const config = requireOAuthConfig();
  const client = await getOrRegisterClient(config);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: existing.refreshToken ?? "",
    client_id: client.clientId
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const tokens = await exchangeToken(config.tokenUrl, body, existing);
  setMcpOAuthTokens(userId, tokens);
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
  if (existing && (!config.registrationUrl || existing.redirectUri === config.redirectUri)) return existing;
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
    tokenEndpointAuthMethod: raw.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none",
    redirectUri: config.redirectUri
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

function requireOAuthConfig(options: McpOAuthConfigOptions = {}): McpOAuthConfig {
  const config = getMcpOAuthConfig(options);
  if (!config) throw new Error("ROBINHOOD_MCP_AUTHORIZATION_URL and ROBINHOOD_MCP_TOKEN_URL are required for MCP OAuth.");
  return config;
}

function resolveRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const host = forwardedHost || firstForwardedValue(request.headers.get("host")) || url.host;
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const protocol = forwardedProto || (isLoopbackHost(host) ? url.protocol.replace(/:$/, "") || "http" : "https");
  return normalizeOrigin(`${protocol}://${host}`) || url.origin;
}

function firstForwardedValue(value: string | null): string | undefined {
  return value
    ?.split(",")[0]
    ?.trim()
    .replace(/\/+$/, "");
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    const end = normalized.indexOf("]");
    if (end >= 0) normalized = normalized.slice(1, end);
  } else if (normalized.includes(":") && !normalized.includes("::")) {
    normalized = normalized.split(":")[0];
  }
  return normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::1" || normalized.startsWith("127.");
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

function base64Url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
