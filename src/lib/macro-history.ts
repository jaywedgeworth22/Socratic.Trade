/**
 * Short trailing histories for the most trend-relevant macro series, fetched from FRED, so the
 * Macro tab can draw sparklines (the main macro layer only keeps the latest value per series).
 * Daily series only (smooth sparklines); cached 12h. Free FRED key required — without it this
 * returns {} and the UI simply omits the trends. Never fabricated.
 */

import { resolveApiKeyWithSource, type ApiKeySource } from "./db";
import { expiresAtRespectingMarketClose } from "./market-hours";

const FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations";
const POINTS = 90; // ~4–5 months of daily observations

/** Friendly key → FRED series id, for the curated set we sparkline. */
const SERIES: Record<string, string> = {
  tenY: "DGS10",
  twoY: "DGS2",
  vix: "VIXCLS",
  hyCreditSpread: "BAMLH0A0HYM2",
  usd: "DTWEXBGS",
  wti: "DCOILWTICO"
};

export type MacroHistory = Partial<Record<keyof typeof SERIES | string, number[]>>;

// ── Cache-provenance scoping (mirrors src/lib/history.ts) ─────────────────────
// Same FRED-key provenance concern as macro.ts: a user-keyed FRED sparkline fetch
// must NOT populate a shared cache that is then served to all other users for 12h.
//
// Opt-in env flag: MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY (default OFF).
// Safe default: unknown provenance → private.

interface MacroHistoryCacheEntry { expiresAt: number; data: MacroHistory }

const sharedMacroHistoryCache: { entry: MacroHistoryCacheEntry | null } = { entry: null };
const privateMacroHistoryCache = new Map<string, MacroHistoryCacheEntry>();

function macroHistoryCacheScopeForKeySource(source: ApiKeySource): "shared" | "private" {
  if (source === "env") return "shared";
  if (source === "user") return shareUserKeyedMacroHistory() ? "shared" : "private";
  return "shared"; // "none" → empty result, safe to share
}

function shareUserKeyedMacroHistory(): boolean {
  const value = (process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY ?? "off").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readMacroHistoryCache(scope: "shared" | "private", userId: string | undefined, now: number): MacroHistory | null {
  if (scope === "private") {
    const key = `user:${userId ?? "local"}`;
    const entry = privateMacroHistoryCache.get(key);
    if (entry && entry.expiresAt > now) return entry.data;
  }
  const shared = sharedMacroHistoryCache.entry;
  if (shared && shared.expiresAt > now) return shared.data;
  return null;
}

function writeMacroHistoryCache(scope: "shared" | "private", userId: string | undefined, data: MacroHistory, expiresAt: number): void {
  if (scope === "shared") {
    sharedMacroHistoryCache.entry = { expiresAt, data };
  } else {
    privateMacroHistoryCache.set(`user:${userId ?? "local"}`, { expiresAt, data });
  }
}

const CACHE_TTL_MS = 12 * 60 * 60_000;

async function fetchSeriesHistory(seriesId: string, apiKey: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${FRED_OBS_URL}?series_id=${seriesId}&limit=${POINTS}&sort_order=desc&api_key=${apiKey}&file_type=json`;
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as { observations?: Array<{ value?: string }> };
    const obs = json?.observations ?? [];
    // API returns newest-first; reverse to chronological and drop missing ('.') values.
    const values: number[] = [];
    for (let i = obs.length - 1; i >= 0; i--) {
      const v = obs[i]?.value;
      if (typeof v === "string" && v !== ".") {
        const n = Number(v);
        if (Number.isFinite(n)) values.push(n);
      }
    }
    return values.length >= 5 ? values : null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export async function fetchMacroHistory(now: number = Date.now(), userId?: string): Promise<MacroHistory> {
  const { key: apiKey, source } = resolveApiKeyWithSource("fred", userId);
  const scope = macroHistoryCacheScopeForKeySource(source);

  const cached = readMacroHistoryCache(scope, userId, now);
  if (cached) return cached;

  if (!apiKey) return {};

  const entries = Object.entries(SERIES);
  const results = await Promise.all(entries.map(([, id]) => fetchSeriesHistory(id, apiKey).catch(() => null)));
  const data: MacroHistory = {};
  entries.forEach(([key], i) => {
    const series = results[i];
    if (series && series.length > 0) data[key] = series;
  });

  // Only cache a non-empty result, so a cold-start FRED hiccup self-heals on the next poll
  // instead of caching an empty trends panel for 12h.
  if (Object.keys(data).length > 0) {
    writeMacroHistoryCache(scope, userId, data, expiresAtRespectingMarketClose(new Date(now), CACHE_TTL_MS));
  }
  return data;
}

/** Clear both caches (test helper). */
export function clearMacroHistoryCacheForTests(): void {
  sharedMacroHistoryCache.entry = null;
  privateMacroHistoryCache.clear();
}
