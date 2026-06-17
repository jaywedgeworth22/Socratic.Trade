// Web-sources subsystem entry point.
//
// One place for the rest of the app to:
//   - refresh due connectors (called from the scheduler tick, gated by cadence),
//   - read the per-symbol overlay (called from the market scan), and
//   - collect 1-line evidence bulletins (fed to the agent prompt).
//
// Adding a new backend source = add a connector module and register it here, then
// fold its per-symbol contribution into getSymbolWebSignals/collectEvidenceBulletins.

import {
  congressTtlMs,
  getCongressDataset,
  getCongressSignals,
  isCongressRefreshDue,
  refreshCongress
} from "./congress";
import {
  getInsiderDataset,
  getInsiderSignals,
  insiderTtlMs,
  isInsiderRefreshDue,
  refreshInsider
} from "./sec";
import {
  finraTtlMs,
  getFinraDataset,
  getShortVolumeSignals,
  isFinraRefreshDue,
  refreshFinra
} from "./finra";
import type { SymbolWebSignal, WebSourceRefreshResult } from "./types";

export type { CongressSignal, CongressTrade, SymbolWebSignal, WebSourceRefreshResult } from "./types";
export { getCongressDataset, getCongressSignals, refreshCongress } from "./congress";
export { getInsiderDataset, getInsiderSignals, refreshInsider } from "./sec";
export { getFinraDataset, getShortVolumeSignals, refreshFinra } from "./finra";

/** Whether the congress connector is enabled (default on; disable with WEB_SOURCE_CONGRESS=off). */
function congressEnabled(): boolean {
  return (process.env.WEB_SOURCE_CONGRESS ?? "on").toLowerCase() !== "off";
}

/** Whether the SEC insider connector is enabled (default on; disable with WEB_SOURCE_INSIDER=off). */
function insiderEnabled(): boolean {
  return (process.env.WEB_SOURCE_INSIDER ?? "on").toLowerCase() !== "off";
}

/** Whether the FINRA short-volume connector is enabled (default on; disable with WEB_SOURCE_FINRA=off). */
function finraEnabled(): boolean {
  return (process.env.WEB_SOURCE_FINRA ?? "on").toLowerCase() !== "off";
}

// Guard against overlapping refreshes: the scheduler fires this fire-and-forget
// every 60s, but a scrape can take longer than a tick. Without this, a slow refresh
// could overlap the next tick's refresh and double-hit the same .gov sources.
let refreshInFlight = false;

/**
 * Refresh every due connector. Safe to call frequently (e.g. each 60s scheduler
 * tick) — each connector no-ops until its own cadence elapses, and overlapping calls
 * are skipped. Fully guarded so a scrape failure can never throw into the scheduler.
 */
export async function refreshDueWebSources(now: number = Date.now()): Promise<WebSourceRefreshResult[]> {
  if (refreshInFlight) return [];
  refreshInFlight = true;
  try {
    return await runDueRefreshes(now);
  } finally {
    refreshInFlight = false;
  }
}

async function runDueRefreshes(now: number): Promise<WebSourceRefreshResult[]> {
  const results: WebSourceRefreshResult[] = [];
  if (congressEnabled() && isCongressRefreshDue(now)) {
    try {
      results.push(await refreshCongress(now));
    } catch (error) {
      results.push({ id: "congress", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  if (insiderEnabled() && isInsiderRefreshDue(now)) {
    try {
      results.push(await refreshInsider(now));
    } catch (error) {
      results.push({ id: "insider", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  if (finraEnabled() && isFinraRefreshDue(now)) {
    try {
      results.push(await refreshFinra(now));
    } catch (error) {
      results.push({ id: "finra", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  return results;
}

/**
 * Per-symbol overlay built from cached web-source datasets (no network). Merged onto
 * quotes in the market scan. Returns only symbols that actually have a signal.
 */
export function getSymbolWebSignals(symbols: string[], now: number = Date.now()): Record<string, SymbolWebSignal> {
  const out: Record<string, SymbolWebSignal> = {};
  const congress = congressEnabled() ? getCongressSignals(symbols, now) : {};
  for (const [symbol, signal] of Object.entries(congress)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.congress = signal;
    entry.bulletins.push(signal.bulletin);
  }
  const insider = insiderEnabled() ? getInsiderSignals(symbols, now) : {};
  for (const [symbol, signal] of Object.entries(insider)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.insiderSentiment = signal.insiderSentiment;
    entry.bulletins.push(signal.bulletin);
  }
  const shortVol = finraEnabled() ? getShortVolumeSignals(symbols) : {};
  for (const [symbol, signal] of Object.entries(shortVol)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.shortVolumeRatio = signal.shortVolumeRatio;
    if (signal.bulletin) entry.bulletins.push(signal.bulletin);
  }
  return out;
}

/** Flat 1-line bulletins per symbol for the agent prompt (raw rows stay out of the prompt). */
export function collectEvidenceBulletins(symbols: string[], now: number = Date.now()): Record<string, string[]> {
  const signals = getSymbolWebSignals(symbols, now);
  const out: Record<string, string[]> = {};
  for (const [symbol, signal] of Object.entries(signals)) {
    if (signal.bulletins.length > 0) out[symbol] = signal.bulletins;
  }
  return out;
}

/** Health/status for the dashboard (which sources, how fresh, how many records). */
export function getWebSourcesStatus(): {
  congress: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
  insider: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
  finra: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number; asOf?: string };
} {
  const congress = getCongressDataset();
  const insider = getInsiderDataset();
  const finra = getFinraDataset();
  return {
    congress: {
      enabled: congressEnabled(),
      fetchedAt: congress?.fetchedAt,
      recordCount: congress?.recordCount ?? 0,
      sources: congress?.sources ?? [],
      due: isCongressRefreshDue(),
      ttlMs: congressTtlMs()
    },
    insider: {
      enabled: insiderEnabled(),
      fetchedAt: insider?.fetchedAt,
      recordCount: insider?.recordCount ?? 0,
      sources: insider ? ["sec-edgar"] : [],
      due: isInsiderRefreshDue(),
      ttlMs: insiderTtlMs()
    },
    finra: {
      enabled: finraEnabled(),
      fetchedAt: finra?.fetchedAt,
      recordCount: finra?.recordCount ?? 0,
      sources: finra ? ["finra"] : [],
      due: isFinraRefreshDue(),
      ttlMs: finraTtlMs(),
      asOf: finra?.asOf
    }
  };
}
