/** Typed fetch helpers for the Settings sub-sections (brokers, API keys,
 *  models, delivery channels). Self-contained on purpose — the shared console
 *  client (app/console/lib/api.ts) stays untouched; only its ConsoleApiError
 *  is reused so every settings error surfaces through the same toast pattern.
 *  Every function talks to REAL existing endpoints — nothing here simulates. */

import { ConsoleApiError } from "../lib/api";

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json().catch(() => undefined);
  }
  return res.text().catch(() => undefined);
}

function messageFrom(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.message === "string" && p.message) return p.message;
    if (typeof p.error === "string" && p.error) return p.error;
  }
  return fallback;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
    });
  } catch {
    throw new ConsoleApiError("Network error — the server could not be reached.", 0);
  }
  const payload = await parseBody(res);
  if (!res.ok) {
    throw new ConsoleApiError(messageFrom(payload, `Request failed (${res.status}).`), res.status, payload);
  }
  return payload as T;
}

// ── Source / data-plane feature settings (per-user overrides of Infisical knobs) ─

export interface SourceFeatureRow {
  id: string;
  group: string;
  label: string;
  description: string;
  type: "boolean" | "number" | "string";
  defaultValue: boolean | number | string;
  min?: number;
  max?: number;
  advanced?: boolean;
  caveat?: string;
  value: boolean | number | string;
  source: "user" | "env" | "default";
}

export interface SourceFeaturesResponse {
  ok: boolean;
  groups: Record<string, { title: string; blurb: string }>;
  settings: SourceFeatureRow[];
}

export function fetchSourceFeatures(): Promise<SourceFeaturesResponse> {
  return request<SourceFeaturesResponse>("/api/settings/source-features");
}

export function patchSourceFeatures(
  settings: Record<string, boolean | number | string | null>
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/settings/source-features", {
    method: "PATCH",
    body: JSON.stringify({ settings })
  });
}

// ── Broker connections ───────────────────────────────────────────────────────

/** Where the browser must go to start Robinhood OAuth (full-page redirect —
 *  the flow returns to the legacy dashboard, which finishes the account sync). */
export const ROBINHOOD_OAUTH_START_URL = "/api/auth/robinhood/start";

export interface RobinhoodMcpHealth {
  ok: boolean;
  configured: boolean;
  authenticated: boolean;
  tools: string[];
  checkedAt: string;
  error?: string;
}

/** GET /api/broker/mcp/health — is the Robinhood MCP OAuth session usable? */
export function fetchRobinhoodHealth(): Promise<RobinhoodMcpHealth> {
  return request<RobinhoodMcpHealth>("/api/broker/mcp/health");
}

/** POST /api/connected-accounts {broker:"robinhood"} — after OAuth, pull the
 *  real agentic account from the live MCP into connected accounts. Idempotent
 *  server-side (re-sync reuses the existing row). */
export function syncRobinhoodAccount(): Promise<{ ok: boolean; accountNumber?: string; label?: string }> {
  return request<{ ok: boolean; accountNumber?: string; label?: string }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "robinhood" })
  });
}

export interface AlpacaConnectBody {
  label?: string;
  accountNumber: string;
  apiKey: string;
  apiSecret?: string;
  taxationType?: "taxable" | "roth_ira" | "traditional_ira";
}

/** POST /api/connected-accounts {broker:"alpaca", ...}. The server infers
 *  paper vs live from the credentials ("PA…" account / "PK…" key = paper) and
 *  fills the default endpoint — no base URL needed here. */
export function connectAlpacaAccount(body: AlpacaConnectBody): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "alpaca", ...body })
  });
}

export interface TradierConnectBody {
  label?: string;
  apiKey: string;
  environment: "paper" | "live";
  accountNumber?: string;
  taxationType?: "taxable" | "roth_ira" | "traditional_ira";
}

/** POST /api/connected-accounts {broker:"tradier", ...}. Single access token (no secret). The
 *  environment is an explicit selector (Sandbox=paper / Production=live) — Tradier tokens carry no
 *  PK/PA-style prefix — and the server derives the sandbox/production endpoint from it. */
export function connectTradierAccount(body: TradierConnectBody): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "tradier", ...body })
  });
}

/** DELETE /api/connected-accounts/[id] — removes the connection (and its
 *  stored credentials) from this app. Nothing at the broker is touched. */
export function disconnectAccount(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/connected-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** PATCH /api/connected-accounts/[id] {label} — rename an account's cosmetic display
 *  name only. The broker-sourced account number and credentials are untouched. */
export function renameAccount(id: string, label: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/connected-accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ label })
  });
}

// ── API keys ─────────────────────────────────────────────────────────────────

/** One catalog entry from GET /api/keys. The key VALUE is never returned by
 *  the server — only whether one resolves and where it came from. */
export interface ApiKeyPlanTierOption {
  id: string;
  label: string;
  hint?: string;
}

export interface ApiKeyEntry {
  service: string;
  label: string;
  category: string;
  unlocks: string;
  docsUrl: string;
  envVar?: string;
  /** True when a key resolves for this user (own key or server env). */
  configured: boolean;
  /** "user" = your stored key, "env" = the server operator's env var, "none". */
  source: "user" | "env" | "none";
  /** Elided first-8/last-4 form of the key that ACTUALLY resolves ("sk-or-v1-...ab12") — never a
   *  usable value. Absent for a server key when you are not the operator, and for keys too short
   *  to elide safely. */
  preview?: string;
  /** Set only when YOU have a stored key. */
  updatedAt?: string;
  savedLabel?: string;
  /** UI text override (default is "key", e.g., "contact" for SEC) */
  credentialName?: string;
  /** Declared vendor plan tier (free/power/starter/…). Present for optional market-data keys. */
  planTier?: string;
  planTierOptions?: ApiKeyPlanTierOption[];
  /** ST product retired (e.g. FMP) — show badge, disable add when CT-only. */
  retired?: boolean;
  retiredNote?: string;
}

export function listApiKeys(): Promise<{ keys: ApiKeyEntry[] }> {
  return request<{ keys: ApiKeyEntry[] }>("/api/keys");
}

/** POST /api/keys — add or replace your key for a service. The value is sent
 *  once and stored server-side; it is never echoed back. */
export function saveApiKey(
  service: string,
  apiKey: string,
  label?: string,
  planTier?: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("/api/keys", {
    method: "POST",
    body: JSON.stringify({
      service,
      apiKey,
      ...(label?.trim() ? { label: label.trim() } : {}),
      ...(planTier ? { planTier } : {})
    })
  });
}

/** POST /api/keys with planTier only — update declared plan without re-pasting the secret. */
export function saveApiKeyPlanTier(service: string, planTier: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("/api/keys", {
    method: "POST",
    body: JSON.stringify({ service, planTier })
  });
}

export function deleteApiKey(service: string): Promise<{ success: boolean; deleted: boolean }> {
  return request<{ success: boolean; deleted: boolean }>(`/api/keys?service=${encodeURIComponent(service)}`, {
    method: "DELETE"
  });
}

// ── Delivery channels (out-of-app alert delivery) ────────────────────────────

export interface DeliveryChannelDescriptor {
  id: "push" | "pushover" | "webhook" | "email" | "sms" | "apns";
  label: string;
  /** False when the server operator hasn't configured the channel's provider. */
  available: boolean;
  provider?: string | null;
  targetField: string;
  targetLabel: string;
  placeholder: string;
  hint: string;
  /** True when the delivery target is app-managed rather than user-typed (apns: the iOS app
   *  registers its own device tokens), so the UI shows an explanation instead of an input. */
  managedTarget?: boolean;
}

export interface DeliveryPrefs {
  channels: string[];
  pushTarget: string;
  pushoverTarget: string;
  webhookUrl: string;
  email: string;
  phone: string;
  /** Presence flags for per-user channel credentials (server never returns
   *  the secret values themselves). */
  pushoverAppTokenSet?: boolean;
  twilioAccountSidSet?: boolean;
  twilioAuthTokenSet?: boolean;
  twilioFromSet?: boolean;
  /** Write-only credential inputs: send a non-empty string to set/replace,
   *  "" to clear, and omit (undefined) to leave the stored value untouched. */
  pushoverAppToken?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFrom?: string;
  /** Opt-in daily watchlist digest (default false) — see settings/delivery.tsx. */
  watchlistDigestEnabled?: boolean;
}

export const EMPTY_DELIVERY_PREFS: DeliveryPrefs = {
  channels: [],
  pushTarget: "",
  pushoverTarget: "",
  webhookUrl: "",
  email: "",
  phone: "",
  watchlistDigestEnabled: false
};

export function fetchDeliverySettings(): Promise<{ channels: DeliveryChannelDescriptor[]; prefs: DeliveryPrefs }> {
  return request<{ channels: DeliveryChannelDescriptor[]; prefs: DeliveryPrefs }>("/api/notifications");
}

export function saveDeliveryPrefs(prefs: DeliveryPrefs): Promise<{ prefs: DeliveryPrefs }> {
  return request<{ prefs: DeliveryPrefs }>("/api/notifications", {
    method: "POST",
    body: JSON.stringify(prefs)
  });
}
