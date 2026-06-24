// App A (congress.trade) analytics overlay — the public "Trends" composite (ticker-leaderboard +
// cluster-buys + member-leaderboard) that App B can't derive from raw trades alone: dollar-weighted
// net flow, distinct-member counts, cluster buys (many members → same ticker), and member track-record.
//
// Refreshed on the scheduler (daily cadence) and persisted, then read synchronously by
// getSymbolWebSignals — mirroring the other web-source connectors (refresh → persist → no-network read).
// Default OFF (CONGRESS_ANALYTICS_ENABLED). Self-guarded; a 0-row pull keeps any prior dataset.

import { audit, getInternalSetting, setInternalSetting } from "../db";
import {
  congressAnalyticsEnabled,
  getAppAClusterBuys,
  getAppAMemberLeaderboard,
  getAppATickerLeaderboard,
  type AppAMemberRow
} from "../congress-trade-client";
import { normalizeSymbol } from "../money";
import type { CongressAnalytics, WebSourceRefreshResult } from "./types";

const DATASET_KEY = "webSource:congressAnalytics:dataset";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily
const DEFAULT_WINDOW_DAYS = 90;
const TICKER_LIMIT = 1000;
const CLUSTER_LIMIT = 200;
const MEMBER_LIMIT = 500;

export { congressAnalyticsEnabled };

interface CongressAnalyticsDataset {
  overlay: Record<string, CongressAnalytics>;
  fetchedAt: string;
  recordCount: number;
  windowDays: number;
}

function ttlMs(): number {
  const v = Number(process.env.CONGRESS_ANALYTICS_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function windowDays(): number {
  const v = Number(process.env.CONGRESS_ANALYTICS_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_DAYS;
}

export function getCongressAnalyticsDataset(): CongressAnalyticsDataset | undefined {
  return getInternalSetting<CongressAnalyticsDataset>(DATASET_KEY);
}

export function isCongressAnalyticsRefreshDue(now: number = Date.now()): boolean {
  const ds = getCongressAnalyticsDataset();
  if (!ds?.fetchedAt) return true;
  return now - Date.parse(ds.fetchedAt) >= ttlMs();
}

/** Per-symbol analytics overlay for the requested symbols (sync; reads the cached dataset). */
export function getCongressAnalyticsOverlay(symbols: string[]): Record<string, CongressAnalytics> {
  const ds = getCongressAnalyticsDataset();
  if (!ds) return {};
  const out: Record<string, CongressAnalytics> = {};
  for (const raw of symbols) {
    const sym = normalizeSymbol(raw);
    if (sym && ds.overlay[sym]) out[sym] = ds.overlay[sym];
  }
  return out;
}

/**
 * Build a member → 0–100 weight from the leaderboard, rank-normalized over the chosen activity metric.
 * App A's member-leaderboard exposes ACTIVITY numerics (estVolumeUsd / tradeCount / netSentiment), not a
 * realized-performance/skill metric — so this is a prominence/conviction proxy (big dollar traders rank
 * high), NOT a track record. Upgrade to true skill-weighting when App A exposes per-member performance
 * (or App B aggregates /api/analytics/performance/:txId). Returns empty until filer_id resolves on App A
 * (member-leaderboard is empty while members are unresolved).
 */
export function buildMemberScores(members: AppAMemberRow[]): Map<string, number> {
  const PERF_FIELDS = ["estVolumeUsd", "tradeCount"]; // App A's real per-member magnitude fields
  const scored: Array<{ name: string; perf: number }> = [];
  for (const m of members) {
    const name = String(m.fullName || m.memberName || m.name || "").trim().toLowerCase();
    if (!name) continue;
    let perf: number | undefined;
    for (const f of PERF_FIELDS) {
      const v = m[f];
      if (typeof v === "number" && Number.isFinite(v)) {
        perf = v;
        break;
      }
    }
    if (perf !== undefined) scored.push({ name, perf });
  }
  const map = new Map<string, number>();
  if (scored.length === 0) return map;
  scored.sort((a, b) => b.perf - a.perf);
  scored.forEach((s, i) => map.set(s.name, Math.round(100 * (1 - i / Math.max(1, scored.length - 1)))));
  return map;
}

export async function refreshCongressAnalytics(now: number = Date.now(), force = false): Promise<WebSourceRefreshResult> {
  if (!congressAnalyticsEnabled()) {
    return { id: "congress-analytics", ok: true, recordCount: 0, sources: [], fetchedAt: "", skipped: true };
  }
  if (!force && !isCongressAnalyticsRefreshDue(now)) {
    const ds = getCongressAnalyticsDataset();
    return { id: "congress-analytics", ok: true, recordCount: ds?.recordCount ?? 0, sources: ["congress.trade"], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }

  const window = `${windowDays()}d`;
  const [leaders, clusters, members] = await Promise.all([
    getAppATickerLeaderboard({ window, limit: TICKER_LIMIT }),
    getAppAClusterBuys({ window, limit: CLUSTER_LIMIT }),
    getAppAMemberLeaderboard({ window, limit: MEMBER_LIMIT })
  ]);

  if (leaders.length === 0 && clusters.length === 0) {
    // App A cold / no recent data — keep any prior dataset rather than wiping to empty.
    const prior = getCongressAnalyticsDataset();
    audit("web_source_refresh", { id: "congress-analytics", ok: false, recordCount: 0, reason: "empty" });
    return {
      id: "congress-analytics",
      ok: false,
      recordCount: prior?.recordCount ?? 0,
      sources: ["congress.trade"],
      fetchedAt: prior?.fetchedAt ?? "",
      warning: "no analytics rows"
    };
  }

  const memberScores = buildMemberScores(members);
  const overlay: Record<string, CongressAnalytics> = {};
  for (const t of leaders) {
    const sym = normalizeSymbol(t.ticker);
    if (!sym) continue;
    const entry: CongressAnalytics = {};
    if (typeof t.estNetFlowUsd === "number") entry.netFlowUsd = t.estNetFlowUsd;
    if (typeof t.estVolumeUsd === "number") entry.estVolumeUsd = t.estVolumeUsd;
    if (typeof t.tradeCount === "number") entry.tradeCount = t.tradeCount;
    if (typeof t.buyCount === "number") entry.buyCount = t.buyCount;
    if (typeof t.sellCount === "number") entry.sellCount = t.sellCount;
    if (typeof t.memberCount === "number") entry.memberCount = t.memberCount;
    if (typeof t.netSentiment === "number") entry.netSentiment = t.netSentiment;
    overlay[sym] = entry;
  }
  for (const c of clusters) {
    const sym = normalizeSymbol(typeof c.ticker === "string" ? c.ticker : "");
    if (!sym) continue;
    const entry = (overlay[sym] ??= {});
    entry.cluster = true;
    if (typeof c.memberCount === "number") entry.clusterMemberCount = c.memberCount;
    const topMembers = Array.isArray(c.topMembers) ? c.topMembers : [];
    let best = 0;
    for (const m of topMembers) {
      const name = String((m?.fullName || m?.memberName || m?.name) ?? "").trim().toLowerCase();
      const s = name ? memberScores.get(name) : undefined;
      if (typeof s === "number" && s > best) best = s;
    }
    if (best > 0) entry.topMemberScore = best;
  }

  const recordCount = Object.keys(overlay).length;
  const dataset: CongressAnalyticsDataset = {
    overlay,
    fetchedAt: new Date(now).toISOString(),
    recordCount,
    windowDays: windowDays()
  };
  setInternalSetting(DATASET_KEY, dataset);
  audit("web_source_refresh", {
    id: "congress-analytics",
    ok: true,
    recordCount,
    tickers: leaders.length,
    clusters: clusters.length,
    members: members.length
  });
  return { id: "congress-analytics", ok: true, recordCount, sources: ["congress.trade"], fetchedAt: dataset.fetchedAt };
}
