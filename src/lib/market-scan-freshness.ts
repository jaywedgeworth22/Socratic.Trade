// market-scan-freshness.ts — scheduler lane guaranteeing Market Scan data is refreshed at
// least every MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS, including over weekends when no strategy
// run fires (isRunAllowedNow/isTradingDay block trading on non-trading days, and scanMarket
// otherwise has no scheduled caller — see docs/rollouts/2026-08-01-data-cascade-freshness-handoff.md).
//
// This is a DATA-FRESHNESS lane, not a trading lane: it deliberately does NOT pass through
// isRunAllowedNow/isTradingDay, never places an order, and never invokes the LLM — it only
// calls scanMarket (a read-only screener/enrichment fetch) and persists the result under the
// `market_scan` audit kind (the same kind app/api/scan/route.ts already writes on an
// interactive refresh; dashboard.ts already reads the newer of `market_scan` and
// `strategy_run` — see fullMarketScan/`latestScan` there).
//
// Cost posture: on a trading day, run the full enrichment scan (fundamentals are still worth
// refreshing). On a non-trading day, run in `enrichmentMode: "skip"` seeded from the newest
// persisted scan's quotesBySymbol — a keyless price/breadth refresh that burns no keyed
// provider quota, mirroring the interactive /api/scan path.
import { audit, getPolicy, latestAuditByKind, newerAuditEntry, type AuditEventRow } from "./db";
import { dynamicIndexUniversesForPolicy } from "./index-universes";
import { isTradingDay } from "./market-calendar";
import { scanMarket } from "./market";
import { allowedSymbolsForPolicy } from "./policy";
import { interactiveScanKey, marketScanQuotesFromAudit, runScanSingleFlight } from "./scan-singleflight";
import type { MarketScan } from "./types";

const DEFAULT_MAX_AGE_HOURS = 20;
const FRESHNESS_USER_ID = "local"; // sole-user app today; see AGENTS.md "Sole user, no compat tax"

/** `MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS` env knob: how stale the newest persisted scan may get
 *  before this lane refreshes it. `0` disables the lane entirely. Unset/invalid falls back to
 *  the 20h default (comfortably inside a ~60h Friday-close-to-Monday-open weekend gap). */
export function marketScanFreshnessMaxAgeHours(): number {
  const raw = process.env.MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_AGE_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_AGE_HOURS;
}

function extractScan(payload: unknown): MarketScan | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const scan = (payload as { scan?: unknown }).scan ?? (payload as { marketScan?: unknown }).marketScan;
  return scan && typeof scan === "object" ? (scan as MarketScan) : undefined;
}

/**
 * The newest persisted MarketScan across BOTH audit kinds that can carry one — a scheduled/
 * interactive `market_scan` audit (payload `{ scan }`) and a `strategy_run` audit's embedded
 * `result.marketScan` — account-scoped preferred, falling back to user-wide (mirrors the
 * lookup dashboard.ts already does for `snapshot.latestScan`). Compares the two kinds' latest
 * rows independently rather than picking "whichever audit row is newest, period": a strategy_run
 * that skipped (e.g. kill switch) is still the newer AUDIT ROW but carries no marketScan, and
 * must not mask an older-but-still-usable market_scan. Returns undefined only when NEITHER kind
 * has ever produced a usable scan payload.
 */
export function newestPersistedMarketScan(
  userId: string,
  connectedAccountId?: string
): { scan: MarketScan; entry: AuditEventRow } | undefined {
  const scanAudit = (connectedAccountId ? latestAuditByKind("market_scan", userId, connectedAccountId) : undefined)
    ?? latestAuditByKind("market_scan", userId);
  const runAudit = (connectedAccountId ? latestAuditByKind("strategy_run", userId, connectedAccountId) : undefined)
    ?? latestAuditByKind("strategy_run", userId);

  const fromScan = scanAudit && extractScan(scanAudit.payload) ? { scan: extractScan(scanAudit.payload)!, entry: scanAudit } : undefined;
  const fromRun = runAudit && extractScan(runAudit.payload) ? { scan: extractScan(runAudit.payload)!, entry: runAudit } : undefined;
  if (!fromScan) return fromRun;
  if (!fromRun) return fromScan;
  return newerAuditEntry(fromScan.entry, fromRun.entry) === fromRun.entry ? fromRun : fromScan;
}

/** Deterministic single-flight key for this lane's own scan, stable across repeated calls with
 *  the same policy/universe so a lane invocation still in flight (audit not yet persisted) never
 *  causes a second tick to kick off a duplicate scanMarket call — see runScanSingleFlight. */
function freshnessScanKey(policy: ReturnType<typeof getPolicy>, symbols: string[], dynamicUniverses: ReturnType<typeof dynamicIndexUniversesForPolicy>): string {
  return interactiveScanKey({
    userId: FRESHNESS_USER_ID,
    accountNumber: policy.accountNumber,
    symbols,
    candidateLimit: policy.marketScanCandidateLimit,
    outlierReserve: policy.marketScanOutlierReserve,
    dynamicUniverses,
    scoringWeights: policy.scoringWeights,
    universeFloor: policy.universeFloor,
    // No broker call in this lane (see module comment) — positions are always empty, which also
    // keeps this key stable across ticks instead of chasing a live portfolio it never fetches.
    positions: []
  });
}

/**
 * Scheduler entry point: refresh the persisted Market Scan when it has gone stale, independent
 * of trading gates. Self-guarded — never throws into the tick.
 */
export async function runMarketScanFreshnessIfDue(now: number = Date.now()): Promise<void> {
  try {
    const maxAgeHours = marketScanFreshnessMaxAgeHours();
    if (maxAgeHours <= 0) return; // 0 disables the lane

    const policy = getPolicy(FRESHNESS_USER_ID);
    const newest = newestPersistedMarketScan(FRESHNESS_USER_ID, policy.connectedAccountId);
    const ageMs = newest ? now - Date.parse(newest.entry.createdAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(ageMs) && ageMs < maxAgeHours * 60 * 60_000) return; // still fresh

    const symbols = allowedSymbolsForPolicy(policy);
    const dynamicUniverses = dynamicIndexUniversesForPolicy(policy);
    const tradingDay = isTradingDay(new Date(now));
    const seedEnrichment = !tradingDay && newest
      ? marketScanQuotesFromAudit(newest.entry.payload, newest.entry.createdAt, now)
      : undefined;

    const key = freshnessScanKey(policy, symbols, dynamicUniverses);
    const scan = await runScanSingleFlight(key, () =>
      scanMarket(symbols, [], policy.scoringWeights, FRESHNESS_USER_ID, dynamicUniverses, {
        candidateLimit: policy.marketScanCandidateLimit,
        outlierReserve: policy.marketScanOutlierReserve,
        universeFloor: policy.universeFloor,
        enrichmentMode: tradingDay ? undefined : "skip",
        seedEnrichment
      })
    );

    try {
      audit("market_scan", { scan }, FRESHNESS_USER_ID, policy.connectedAccountId);
    } catch {
      /* audit is diagnostic only */
    }
  } catch (err) {
    console.error("[market-scan-freshness] error:", err instanceof Error ? err.message : err);
  }
}
