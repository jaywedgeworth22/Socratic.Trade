import { getInternalSetting, getServiceHealthSummaries, databasePath, resolveApiKeyWithSource, alertStorageWarning } from "@/lib/db";
import { HEALTH_REASON_CONSECUTIVE_FAILURES } from "@/lib/db-health";
import { activeEmbeddingProvider } from "@/lib/vector-db";
import { getProviderTierStatus } from "@/lib/provider-tier";
import {
  assessLitestreamRuntimeHealth,
  defaultLitestreamStatePath,
  getLitestreamRuntimeHealth,
  runtimeReleaseIdentity
} from "@/lib/runtime-health";
import { getLease } from "@/lib/scheduler-lease";
import { getTradingLivenessSummary } from "@/lib/trading-liveness";
import { statSync, statfsSync } from "fs";
import { dirname } from "path";

export const dynamic = "force-dynamic";

// Real liveness probe (was an unconditional {ok:true}). A health check that can never fail is
// worse than none for a system that can hold real positions — it hides outages. This probes:
//   - DB reachability (the getInternalSetting read throws if SQLite is unwritable/locked), and
//   - scheduler liveness (age of the last tick heartbeat; stale ⇒ autonomy/stops aren't running).
// Returns 503 when a critical check fails so PM2/uptime tooling can act.
export async function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  const release = runtimeReleaseIdentity();
  checks.release = release;

  let lastTick: string | undefined;
  try {
    lastTick = getInternalSetting<string>("scheduler:lastTick"); // also proves the DB is reachable
    checks.db = "ok";
  } catch (error) {
    ok = false;
    checks.db = error instanceof Error ? error.message : "error";
  }

  if (lastTick) {
    const ageMs = Date.now() - new Date(lastTick).getTime();
    checks.schedulerLastTick = lastTick;
    checks.schedulerAgeSeconds = Math.round(ageMs / 1000);
    // The scheduler ticks every 60s; >5 min of silence is degraded (not a hard failure here —
    // the process may legitimately be a non-scheduler instance).
    if (ageMs > 5 * 60_000) checks.schedulerStale = true;
  } else {
    checks.schedulerLastTick = null;
  }

  // Scheduler lease state (additive; only meaningful when SCHEDULER_SINGLE_LEADER is on).
  // Surfaced here so ops tooling can confirm which process is the current leader and how old
  // the lease is. Never breaks the liveness probe.
  try {
    const lease = getLease();
    if (lease) {
      checks.schedulerLease = {
        owner: lease.owner,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        ageSeconds: Math.round(lease.ageMs / 1000),
        expired: lease.expired
      };
    } else {
      checks.schedulerLease = null;
    }
  } catch {
    // never let lease reporting break the liveness probe
  }

  // Trading-liveness (handoff 6b.7): the heartbeat above proves the tick FUNCTION runs, not that
  // trading works — a scheduler that ticks while every run fails keeps this route green for hours.
  // Per active-autonomy account (policy.systemState === "active"), report the age of the most
  // recent COMPLETED strategy run and a consecutive-failed-runs count. `degraded`-only — NEVER
  // 503s (see trading-liveness.ts's header comment: a 503 here would trigger a container restart,
  // which re-halts autonomy via the boot interlock — the exact loop 6b.1 fixed). Omitted entirely
  // when there are zero active-autonomy accounts (nothing to be live about).
  //
  // PUBLIC route (no requireAdmin): same convention as the dependencies section below — expose
  // ONLY a minimal aggregate, never the per-account rows. The full summary carries userId,
  // connectedAccountId, and a user-chosen label per account (plus run timestamps); those stay on
  // the authed ops snapshot (buildOpsSnapshot -> computeAccountTradingLiveness in
  // ops-snapshot.ts). Here we fold it down to counts + the oldest age, which is enough for an
  // external uptime probe without leaking account identity.
  try {
    const liveness = getTradingLivenessSummary();
    if (liveness) {
      const degradedCount = liveness.accounts.filter((a) => a.degraded).length;
      const oldestCompletedRunAgeSeconds = liveness.accounts.reduce<number | null>((oldest, a) => {
        if (a.lastCompletedRunAgeSeconds === null) return oldest;
        return oldest === null ? a.lastCompletedRunAgeSeconds : Math.max(oldest, a.lastCompletedRunAgeSeconds);
      }, null);
      checks.tradingLiveness = {
        activeAccounts: liveness.accounts.length,
        degraded: degradedCount,
        oldestCompletedRunAgeSeconds,
        marketOpen: liveness.marketOpen
      };
      if (liveness.degraded) checks.tradingLivenessDegraded = true;
    }
  } catch {
    // never let trading-liveness reporting break the liveness probe
  }

  // Market-data paid-tier watchdog status (per the nightly provider-tier check). Surfaced here so the
  // status/admin/health tool can show whether the Massive/FMP subscriptions are live; a key detected
  // as "free" (lapsed sub) marks the section degraded but does NOT fail the liveness probe.
  try {
    const tiers = getProviderTierStatus();
    if (Object.keys(tiers).length > 0) {
      checks.dataProviders = tiers;
      if (Object.values(tiers).some((t) => t?.tier === "free")) checks.dataProvidersDegraded = true;
    }
  } catch {
    // never let provider-tier reporting break the health probe
  }

  // Surface Pinecone and embed-provider configuration status. Provider-aware
  // (bge-m3-metering-gate, 2026-07-18): "RAG configured" means Pinecone plus the ACTIVE embed
  // provider's key — a missing Voyage key is irrelevant while OpenRouter/SiliconFlow serves
  // embeddings (`activeEmbeddingProvider`, honoring a RAG_EMBED_PROVIDER pin). The historical
  // voyageConfigured field is kept for dashboards that read it, but it no longer drives
  // ragConfigured unless Voyage is genuinely the active provider.
  let ragEmbedProvider: "voyage" | "openrouter" | "siliconflow" | null = null;
  try {
    const pineconeKey = resolveApiKeyWithSource("pinecone");
    const voyageKey = resolveApiKeyWithSource("voyage");
    checks.pineconeConfigured = pineconeKey.source !== "none";
    checks.voyageConfigured = voyageKey.source !== "none";

    try {
      ragEmbedProvider = activeEmbeddingProvider();
      checks.ragEmbedProvider = ragEmbedProvider;
    } catch (error) {
      // RAG_EMBED_PROVIDER pinned to a keyless/invalid provider throws by design at embed time —
      // surface it here as a config problem without breaking the probe.
      checks.ragConfigured = false;
      checks.ragEmbedProviderError = error instanceof Error ? error.message : "invalid RAG embed provider";
    }
    if (ragEmbedProvider) {
      const activeKeyConfigured = ragEmbedProvider === "voyage"
        ? voyageKey.source !== "none"
        : resolveApiKeyWithSource(ragEmbedProvider, "local").source !== "none";
      if (pineconeKey.source === "none" || !activeKeyConfigured) {
        checks.ragConfigured = false;
      }
    }
  } catch {
    // do not break health check on key resolution
  }

  // Surface every backend dependency from health summaries.
  //
  // PUBLIC route (no requireAdmin): expose ONLY boolean/degraded status — never the raw
  // `lastFailureError` provider string (that detailed payload stays on the admin
  // connections-health route). A `degraded` flag captures the soft/cold-start case without
  // failing liveness; the detailed reason text is deliberately omitted here.
  try {
    const summaries = getServiceHealthSummaries();
    const dependencies: Record<string, { ok: boolean; degraded?: boolean }> = {};
    // See the provider-aware voyage criticality comment below. Falls back to treating Voyage as
    // critical when the provider can't be resolved EXCEPT for a pinned-but-keyless
    // RAG_EMBED_PROVIDER (which throws by design) — that misconfiguration is already surfaced via
    // ragEmbedProviderError above, and 503ing the container on it would just restart-loop.
    const criticalServices = new Set(["pinecone", "alpaca-broker"]);
    if (ragEmbedProvider === "voyage" || ragEmbedProvider === null) {
      if (!checks.ragEmbedProviderError) {
        criticalServices.add("voyage");
        criticalServices.add("voyage-rerank");
      }
    }
    // Collapse (service, keySource) lanes to one entry per service. Prefer a CONFIGURED lane
    // (env/user) over a stale keySource:"none" lane so a service that later got a working key isn't
    // pinned failed forever by an old missing-key "none" lane (no future success is logged to "none").
    const configuredService = new Set<string>();
    for (const summary of summaries) {
      if (summary.keySource === "env" || summary.keySource === "user") configuredService.add(summary.service);
    }
    for (const summary of summaries) {
      const isGlobal = summary.keySource === "env" || summary.keySource === "none" || summary.keySource === null;
      if (!isGlobal) continue;
      // Ignore a stale "none"/null lane once the service has a real configured lane — otherwise it
      // would overwrite the healthy env lane and pin the service failed indefinitely.
      const isNoneLane = summary.keySource === "none" || summary.keySource === null;
      if (isNoneLane && configuredService.has(summary.service)) continue;

      // Only the HARD reason (>=5 consecutive failures) fails liveness. The SOFT heuristics
      // ("active this hour but no success yet") that a single cold-start 500 can trip mark the
      // service degraded but must NOT 503.
      const hardStopped = summary.stoppedWorking && summary.stoppedReason === HEALTH_REASON_CONSECUTIVE_FAILURES;
      const existing = dependencies[summary.service];
      const nextOk = !hardStopped;
      const nextDegraded = summary.stoppedWorking && !hardStopped;
      if (existing) {
        // Merge lanes for the same service: any hard-stopped lane wins ok=false; degraded is sticky.
        dependencies[summary.service] = {
          ok: existing.ok && nextOk,
          degraded: existing.degraded || nextDegraded || undefined
        };
      } else {
        dependencies[summary.service] = { ok: nextOk, degraded: nextDegraded || undefined };
      }

      // Hard-liveness deps: only app-unsafe/unusable dependencies 503 the public probe. Paid
      // market-data lanes (fmp/massive) degrade to Yahoo/others (the provider-tier section already
      // reports data-provider degradation), so they mark degraded but never fail liveness.
      //
      // Provider-aware voyage criticality (bge-m3-metering-gate, 2026-07-18): the voyage /
      // voyage-rerank lanes gate liveness ONLY while Voyage is the ACTIVE embed/rerank provider.
      // With prod flipped to bge-m3 via OpenRouter, a dead/stale Voyage lane was 503ing the whole
      // app (and a 503 here can restart the container) for a provider the app no longer calls.
      // The lanes are still REPORTED in `dependencies` either way — this only stops them from
      // failing liveness while inactive. Caveat: the RAG health lanes are still LOGGED under the
      // historical "voyage"/"voyage-rerank" service names regardless of which provider actually
      // served the call (see withRagApiHealth call sites in vector-db.ts), so while a non-Voyage
      // provider is active, embed/rerank failures degrade this route rather than 503 it — renaming
      // those lanes per-provider is a deliberate follow-up, not done here.
      const isCritical = criticalServices.has(summary.service);
      if (isCritical && hardStopped) {
        ok = false;
      }
    }
    checks.dependencies = dependencies;
  } catch {
    // never let connection health summaries break the health probe
  }

  // Disk and database headroom check (purely advisory, never fails the health probe)
  try {
    const dbPath = databasePath();
    const walPath = `${dbPath}-wal`;
    const dbDir = dirname(dbPath);
    let latestLocalActivityAtMs = 0;

    let dbSizeBytes = 0;
    try {
      const dbStat = statSync(dbPath);
      dbSizeBytes = dbStat.size;
      latestLocalActivityAtMs = Math.max(latestLocalActivityAtMs, dbStat.mtimeMs);
    } catch {}

    let walSizeBytes = 0;
    try {
      const walStat = statSync(walPath);
      walSizeBytes = walStat.size;
      latestLocalActivityAtMs = Math.max(latestLocalActivityAtMs, walStat.mtimeMs);
    } catch {}

    let freeBytes = 0;
    let totalBytes = 0;
    try {
      const stats = statfsSync(dbDir);
      freeBytes = stats.bavail * stats.bsize;
      totalBytes = stats.blocks * stats.bsize;
    } catch {}

    const liveMode = process.env.DB_BOOTSTRAP === "live";
    const freshness = await getLitestreamRuntimeHealth({
      dbPath,
      statePath: process.env.LITESTREAM_STATE_PATH?.trim() || defaultLitestreamStatePath(dbPath),
      // File metadata does not prove an R2 upload and may be expensive to scan. In live
      // mode the bounded IPC source is therefore the only accepted runtime signal.
      allowFileFallback: !liveMode
    });
    const litestreamAgeSeconds = freshness.state === "known" ? freshness.ageSeconds : null;
    const litestreamState = freshness.state;
    const litestreamAssessment = assessLitestreamRuntimeHealth(freshness, {
      liveMode,
      processUptimeSeconds: release.processUptimeSeconds,
      latestLocalActivityAtMs: latestLocalActivityAtMs || null
    });

    checks.storage = {
      dbSizeBytes,
      walSizeBytes,
      freeBytes,
      totalBytes,
      litestreamAgeSeconds,
      litestreamState,
      litestreamStatus: freshness.state === "known" ? freshness.status : null,
      litestreamLastSyncAt: freshness.state === "known" ? freshness.lastSyncAt : null,
      litestreamTimestampState: freshness.state === "known" ? freshness.timestampState : null,
      litestreamSource: freshness.source,
      litestreamDegradedReasons: litestreamAssessment.reasons
    };

    // Thresholds:
    // Disk free space < 1 GB or WAL size > 500 MB or Litestream last-sync age > 1 hour (3600s)
    const diskLow = freeBytes > 0 && freeBytes < 1024 * 1024 * 1024;
    const walLarge = walSizeBytes > 500 * 1024 * 1024;

    if (diskLow || walLarge || litestreamAssessment.degraded) {
      checks.storageDegraded = true;

      // Send a one-shot needs-attention notification/alert via the notifier if not sent recently
      if (diskLow) void alertStorageWarning("disk_space_low", `Free disk space is low: ${(freeBytes / 1024 / 1024).toFixed(2)} MB remaining.`);
      if (walLarge) void alertStorageWarning("wal_size_large", `SQLite WAL file size is large: ${(walSizeBytes / 1024 / 1024).toFixed(2)} MB.`);
      for (const reason of litestreamAssessment.reasons) {
        if (reason === "stale") {
          void alertStorageWarning("litestream_replication_stale", `Litestream WAL replication has not synced in ${Math.round((litestreamAgeSeconds ?? 0) / 60)} minutes.`);
        } else if (reason === "stopped") {
          void alertStorageWarning("litestream_replication_stopped", `Litestream reports replication status '${freshness.state === "known" ? freshness.status : "unknown"}'.`);
        } else if (reason === "never-synced") {
          void alertStorageWarning("litestream_replication_never_synced", "Litestream is running but has not reported a successful replica upload after the startup grace period.");
        } else if (reason === "file-unverified") {
          void alertStorageWarning("litestream_replication_unverified", "Only local Litestream metadata activity is visible in DB_BOOTSTRAP=live mode; successful R2 replication is not verified.");
        } else if (reason === "unavailable") {
          void alertStorageWarning("litestream_state_unreadable", "Litestream runtime status is unavailable in DB_BOOTSTRAP=live mode — replication freshness cannot be confirmed.");
        } else if (reason === "invalid-sync-time") {
          void alertStorageWarning("litestream_sync_time_invalid", "Litestream reported an invalid or materially future last-sync timestamp.");
        }
      }
    }
  } catch {
    // never let storage monitoring break the health probe
  }

  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
