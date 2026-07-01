// Read-only Alpaca trading-API account/market observability.
//
// These are GET-only calls against Alpaca's trading API — portfolio history, market
// calendar/clock, and the account activity log. They never place, modify, or cancel an
// order. They mirror the credential resolution, auth headers, timeout, and health-logging
// conventions of the Alpaca enrichment providers in `data-providers.ts` (service names are
// distinct so the admin connection-status page can attribute failures precisely).
//
// Unlike the market-data providers (which hit data.alpaca.markets), these endpoints live on
// the trading API. The credential resolver does not carry the account's paper/live
// environment, so we default to the paper host (matching the app's paper-mode default) and
// allow ALPACA_TRADING_BASE_URL to point at the live host when needed.

import { resolveAlpacaMarketData, type ApiKeySource } from "./db";
import { logApiHealth } from "./db-health";

const DEFAULT_PAPER_BASE = "https://paper-api.alpaca.markets";
const REQUEST_TIMEOUT_MS = 8000;

function tradingBase(): string {
  const raw = String(process.env.ALPACA_TRADING_BASE_URL ?? "").trim();
  return (raw || DEFAULT_PAPER_BASE).replace(/\/+$/, "");
}

function authHeaders(apiKey: string, secretKey?: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (secretKey) {
    headers["APCA-API-KEY-ID"] = apiKey;
    headers["APCA-API-SECRET-KEY"] = secretKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

// GET the trading API and parse JSON, logging health under `service` and degrading to
// undefined on any credential/HTTP/network failure. Never throws.
async function getJson<T>(
  path: string,
  service: string,
  apiKey: string,
  secretKey: string | undefined,
  keySource: ApiKeySource
): Promise<T | undefined> {
  const url = `${tradingBase()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const response = await fetch(url, {
      headers: authHeaders(apiKey, secretKey),
      cache: "no-store",
      signal: controller.signal,
    });
    logApiHealth({
      service,
      ok: response.ok,
      latencyMs: Date.now() - start,
      errorText: response.ok ? undefined : `HTTP ${response.status}`,
      keySource,
    });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch (err) {
    logApiHealth({
      service,
      ok: false,
      latencyMs: Date.now() - start,
      errorText: err instanceof Error ? err.message : String(err),
      keySource,
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

const SERVICE = "alpaca-account-insights";

export interface AlpacaPortfolioHistory {
  timestamp: number[];
  equity: number[];
  profit_loss: number[];
  profit_loss_pct: Array<number | null>;
  base_value?: number;
  timeframe: string;
}

export interface AlpacaCalendarDay {
  date: string;
  open: string;
  close: string;
  session_open?: string;
  session_close?: string;
}

export interface AlpacaMarketClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export interface AlpacaAccountActivity {
  id: string;
  activity_type: string;
  // Trade activities (fills) carry transaction_time/type/price/qty/side/symbol/order_id;
  // non-trade activities (dividends, transfers, fees) carry date/net_amount/description.
  transaction_time?: string;
  date?: string;
  type?: string;
  price?: string;
  qty?: string;
  side?: string;
  symbol?: string;
  leaves_qty?: string;
  cum_qty?: string;
  order_id?: string;
  order_status?: string;
  net_amount?: string;
  per_share_amount?: string;
  description?: string;
  status?: string;
}

// Equity-curve time series (GET /v2/account/portfolio/history). Returns undefined when no
// Alpaca credential is available or the request fails.
export async function fetchAlpacaPortfolioHistory(
  userId: string,
  opts: { period?: string; timeframe?: string } = {}
): Promise<AlpacaPortfolioHistory | undefined> {
  const creds = resolveAlpacaMarketData(userId);
  if (!creds.apiKey) return undefined;

  const params = new URLSearchParams();
  if (opts.period) params.set("period", opts.period);
  if (opts.timeframe) params.set("timeframe", opts.timeframe);
  const query = params.toString();
  const path = `/v2/account/portfolio/history${query ? `?${query}` : ""}`;
  return getJson<AlpacaPortfolioHistory>(path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
}

// Session open/close and holiday info (GET /v2/calendar). Market-wide reference data, so it
// resolves the operator/shared Alpaca credential. Returns an empty array on failure.
export async function fetchAlpacaMarketCalendar(
  opts: { start?: string; end?: string } = {}
): Promise<AlpacaCalendarDay[]> {
  const creds = resolveAlpacaMarketData();
  if (!creds.apiKey) return [];

  const params = new URLSearchParams();
  if (opts.start) params.set("start", opts.start);
  if (opts.end) params.set("end", opts.end);
  const query = params.toString();
  const path = `/v2/calendar${query ? `?${query}` : ""}`;
  const days = await getJson<AlpacaCalendarDay[]>(path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
  return Array.isArray(days) ? days : [];
}

// Current market open/closed state + next open/close (GET /v2/clock). Returns undefined when
// no Alpaca credential is available or the request fails.
export async function fetchAlpacaMarketClock(): Promise<AlpacaMarketClock | undefined> {
  const creds = resolveAlpacaMarketData();
  if (!creds.apiKey) return undefined;
  return getJson<AlpacaMarketClock>("/v2/clock", SERVICE, creds.apiKey, creds.secretKey, creds.source);
}

// Account activity/audit log — fills, dividends, transfers (GET /v2/account/activities).
// Returns an empty array when no Alpaca credential is available or the request fails.
export async function fetchAlpacaAccountActivities(
  userId: string,
  opts: { activityTypes?: string[] } = {}
): Promise<AlpacaAccountActivity[]> {
  const creds = resolveAlpacaMarketData(userId);
  if (!creds.apiKey) return [];

  const types = (opts.activityTypes ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  const params = new URLSearchParams();
  if (types.length > 0) params.set("activity_types", types.join(","));
  const query = params.toString();
  const path = `/v2/account/activities${query ? `?${query}` : ""}`;
  const activities = await getJson<AlpacaAccountActivity[]>(path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
  return Array.isArray(activities) ? activities : [];
}
