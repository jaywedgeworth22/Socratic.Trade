import { CongressTradeClient } from "@jaywedgeworth22/congress-trading-shared";
import { logApiHealth } from "../db-health";

const DEFAULT_BASE_URL = "https://congress.trade";
const DEFAULT_TIMEOUT_MS = 8_000;

function baseUrl(): string {
  return (process.env.CONGRESS_TRADE_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

/**
 * Parse an env flag. When `defaultOn` is true, an unset/blank value enables the
 * feature; explicit off (`0`/`false`/`no`/`off`) still disables it.
 */
function flagOn(value: string | undefined, defaultOn = false): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return defaultOn;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Price/history cache-aside — remains opt-in (can echo Massive via peer; keep default off). */
export function congressReadsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_READS_ENABLED, false);
}

/**
 * Fundamentals/analyst read-back from App A. Default OFF — owner 2026-08-04:
 * Socratic fundamentals come from the multi-provider cascade (Yahoo, Finnhub,
 * ROIC, SEC XBRL, Tiingo, SimFin, …), not from Congress.Trade or direct FMP.
 * Opt in only if you want App A as an extra cache-aside tier.
 */
export function congressFundamentalsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED, false);
}

/**
 * App A as congressional disclosure source of record. Default ON: replaces
 * scrapers / direct Quiver congressional counts (owner 2026-08-04).
 */
export function congressAsCongressSourceEnabled(): boolean {
  return flagOn(process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE, true);
}

/**
 * App A analytics overlay (conviction, clusters, member skill). Default ON so
 * congress composite scoring has a real peer feed without paid alt-data keys.
 */
export function congressAnalyticsEnabled(): boolean {
  return flagOn(process.env.CONGRESS_ANALYTICS_ENABLED, true);
}

function readToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_READ_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function timeoutMs(): number {
  const v = Number(process.env.CONGRESS_TRADE_READ_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

let sharedClientInstance: CongressTradeClient | null = null;

export function getCongressTradeClient(): CongressTradeClient {
  if (!sharedClientInstance) {
    sharedClientInstance = new CongressTradeClient({
      baseUrl: baseUrl(),
      token: readToken(),
      fetch: async (input, init) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs());
        const start = Date.now();
        try {
          const res = await fetch(input, {
            ...init,
            headers: {
              ...(init?.headers || {}),
              "User-Agent": "SocraticTrade/1.0"
            },
            signal: controller.signal,
            cache: "no-store"
          });
          logApiHealth({ service: "congress.trade", ok: res.ok, latencyMs: Date.now() - start, errorText: res.ok ? undefined : `HTTP ${res.status}` });
          // Live `9d71dda4`: a 502 must fail-open gather, not keep pulling the
          // rest of the 250-name batch.  404 stays a miss (return the body).
          if (!res.ok && (res.status === 429 || res.status >= 500)) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res;
        } catch (err) {
          logApiHealth({ service: "congress.trade", ok: false, latencyMs: Date.now() - start, errorText: err instanceof Error ? err.message : String(err) });
          throw err;
        } finally {
          clearTimeout(timer);
        }
      }
    });
  }
  return sharedClientInstance;
}

import type { PriceClose } from "@jaywedgeworth22/congress-trading-shared";
import type { OHLCBar } from "../indicators";

export function appAClosesToBars(closes: PriceClose[] | null | undefined): OHLCBar[] {
  if (!closes || closes.length === 0) return [];
  return closes
    .filter((c) => c && typeof c.close === "number" && Number.isFinite(c.close) && typeof c.date === "string")
    .map((c) => ({
      time: c.date,
      close: c.close,
      ...(typeof c.volume === "number" && Number.isFinite(c.volume) ? { volume: c.volume } : {})
    }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}
