// Read-only Alpaca trading-API account/market observability.
//
// These are GET-only calls against Alpaca's trading API — portfolio history, market
// calendar/clock, and the account activity log. They never place, modify, or cancel an
// order. They mirror the credential resolution, auth headers, timeout, and health-logging
// conventions of the Alpaca enrichment providers in `data-providers.ts` (service names are
// distinct so the admin connection-status page can attribute failures precisely).
//
// Unlike the market-data providers (which hit data.alpaca.markets), these endpoints live on
// the trading API. Private account endpoints must use the requested user's connected
// Alpaca account and its paper/live environment; they must not fall back to shared
// operator market-data credentials.

import { getConnectedAccount, listConnectedAccounts, resolveAlpacaMarketData, type ApiKeySource } from "./db";
import { logApiHealth } from "./db-health";
import type { ConnectedAccount } from "./types";

const DEFAULT_PAPER_BASE = "https://paper-api.alpaca.markets";
const DEFAULT_LIVE_BASE = "https://api.alpaca.markets";
const DEFAULT_ACTIVITIES_PAGE_SIZE = 100;
const DEFAULT_ACTIVITIES_MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 8000;

function tradingBase(environment: "paper" | "live" = "paper"): string {
  const raw = String(process.env.ALPACA_TRADING_BASE_URL ?? "").trim();
  const fallback = environment === "live" ? DEFAULT_LIVE_BASE : DEFAULT_PAPER_BASE;
  return (raw || fallback).replace(/\/+$/, "");
}

function rankAlpacaAccounts(accounts: ConnectedAccount[]): ConnectedAccount[] {
  const ranked = [
    accounts.find((a) => a.isActive && a.environment === "live"),
    accounts.find((a) => a.isActive),
    accounts.find((a) => a.environment === "live"),
    accounts.find((a) => a.environment === "paper"),
    ...accounts
  ];
  const seen = new Set<string>();
  return ranked.filter((account): account is ConnectedAccount => {
    if (!account || seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });
}

function resolvePrivateAlpacaAccount(
  userId: string
): { apiKey: string; secretKey?: string; environment: "paper" | "live"; source: ApiKeySource } | undefined {
  const accounts = rankAlpacaAccounts(listConnectedAccounts(userId).filter((account) => account.broker === "alpaca"));
  for (const account of accounts) {
    const detailed = getConnectedAccount(account.id, userId);
    if (!detailed?.apiKey) continue;
    return {
      apiKey: detailed.apiKey,
      secretKey: detailed.apiSecret,
      environment: detailed.environment === "live" ? "live" : "paper",
      source: "user"
    };
  }
  return undefined;
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
  baseUrl: string,
  path: string,
  service: string,
  apiKey: string,
  secretKey: string | undefined,
  keySource: ApiKeySource
): Promise<T | undefined> {
  const url = `${baseUrl}${path}`;
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
  const creds = resolvePrivateAlpacaAccount(userId);
  if (!creds) return undefined;

  const params = new URLSearchParams();
  if (opts.period) params.set("period", opts.period);
  if (opts.timeframe) params.set("timeframe", opts.timeframe);
  const query = params.toString();
  const path = `/v2/account/portfolio/history${query ? `?${query}` : ""}`;
  return getJson<AlpacaPortfolioHistory>(tradingBase(creds.environment), path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
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
  const days = await getJson<AlpacaCalendarDay[]>(tradingBase(), path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
  return Array.isArray(days) ? days : [];
}

// Current market open/closed state + next open/close (GET /v2/clock). Returns undefined when
// no Alpaca credential is available or the request fails.
export async function fetchAlpacaMarketClock(): Promise<AlpacaMarketClock | undefined> {
  const creds = resolveAlpacaMarketData();
  if (!creds.apiKey) return undefined;
  return getJson<AlpacaMarketClock>(tradingBase(), "/v2/clock", SERVICE, creds.apiKey, creds.secretKey, creds.source);
}

// Account activity/audit log — fills, dividends, transfers (GET /v2/account/activities).
// Returns an empty array when no Alpaca credential is available or the request fails.
export async function fetchAlpacaAccountActivities(
  userId: string,
  opts: { activityTypes?: string[]; pageSize?: number; maxPages?: number } = {}
): Promise<AlpacaAccountActivity[]> {
  const creds = resolvePrivateAlpacaAccount(userId);
  if (!creds) return [];

  const types = (opts.activityTypes ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  const pageSize = Math.max(1, Math.min(100, Math.trunc(opts.pageSize ?? DEFAULT_ACTIVITIES_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.trunc(opts.maxPages ?? DEFAULT_ACTIVITIES_MAX_PAGES));
  const all: AlpacaAccountActivity[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams();
    if (types.length > 0) params.set("activity_types", types.join(","));
    params.set("page_size", String(pageSize));
    if (pageToken) params.set("page_token", pageToken);
    const path = `/v2/account/activities?${params.toString()}`;
    const activities = await getJson<AlpacaAccountActivity[]>(tradingBase(creds.environment), path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
    if (!Array.isArray(activities) || activities.length === 0) break;
    all.push(...activities);
    if (activities.length < pageSize) break;
    const nextToken = activities[activities.length - 1]?.id;
    if (!nextToken || nextToken === pageToken) break;
    pageToken = nextToken;
  }

  return all;
}
