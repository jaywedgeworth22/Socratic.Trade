import { getInternalSetting, getServiceHealthSummaries, databasePath, resolveApiKeyWithSource, alertStorageWarning } from "@/lib/db";
import { HEALTH_REASON_CONSECUTIVE_FAILURES } from "@/lib/db-health";
import { activeEmbeddingProvider } from "@/lib/vector-db";
import type { RagEmbedRerankProvider } from "@/lib/rag-metering";
import { getProviderTierStatus } from "@/lib/provider-tier";
import {
  assessLitestreamRuntimeHealth,
  defaultLitestreamStatePath,
  getLitestreamRuntimeHealth,
  runtimeReleaseIdentity
} from "@/lib/runtime-health";
import { getLease } from "@/lib/scheduler-lease";
import { getTradingLivenessSummary } from "@/lib/trading-liveness";
import { getOpenRouterCreditStatus } from "@/lib/openrouter-credits";
import { authorizeOpsRequest } from "@/lib/ops-auth";
import { statSync, statfsSync } from "fs";
import { dirname } from "path";

export const dynamic = "force-dynamic";

/**
 * Drop the `<pid>:` prefix from a scheduler-lease owner (`${process.pid}:${randomUUID()}`, see
 * scheduler-lease.ts). The uuid half is what makes "did the leader change / is this the same
 * process?" answerable; the pid half is host detail an anonymous caller has no use for. Owners
 * written in some other format are returned untouched.
 */
function leaseOwnerWithoutPid(owner: string): string {
  return owner.replace(/^\d+:/, "");
}

// Real liveness probe (was an unconditional {ok:true}). A health check that can never fail is
// worse than none for a system that can hold real positions — it hides outages. This probes:
//   - DB reachability (the getInternalSetting read throws if SQLite is unwritable/locked), and
//   - scheduler liveness (age of the last tick heartbeat; stale ⇒ autonomy/stops aren't running).
// Returns 503 when a critical check fails so PM2/uptime tooling can act.
//
// TWO AUDIENCES. This route is in middleware's PUBLIC_PREFIXES, so everything it emits is
// world-readable — correct for the external uptime monitor that polls it and for the
// credential-less deploy-verify runbook (.claude/skills/deploy-verify/SKILL.md greps
// `.checks.db`, `.checks.schedulerAgeSeconds`, `.checks.storage.litestream*`). Three items are
// operator-only and are therefore gated on the SAME token as /api/ops/snapshot (`x-ops-token`,
// ops-auth.ts) rather than a second auth scheme:
//   - the OpenRouter prepaid balance in USD — publishing "the LLM budget is nearly exhausted"
//     hands an anonymous caller a precisely-timed, cheap window to drain what is (post-#1703
//     universal routing) the single point of failure for every LLM call and all RAG embedding,
//   - the host disk / SQLite byte counts — free capacity reconnaissance, and
//   - the raw scheduler-lease owner, which carries this container's OS pid.
// Gating is a PROJECTION only: `ok`, the 200/503 status, and every degraded flag are computed from
// the same values either way and are byte-identical between the two views. Do not fold any of this
// into the status logic — a spurious 503 restarts the container, which re-halts autonomy via the
// boot interlock (see the trading-liveness note below).
//
// Failure mode worth knowing: authorizeOpsRequest fails closed on an UNCONFIGURED secret — with
// neither OPS_DIAGNOSTIC_TOKEN nor ADMIN_REINDEX_TOKEN set it returns false for everyone, quietly,
// so the operator sees the public view too. That is the same condition that already makes
// /api/ops/snapshot unusable, so it is a token-provisioning problem, not a health-route one; the
// full lease owner is still on /api/ready (session-gated, no ops token needed) either way.
export async function GET(request: Request) {
  const checks: Record<string, unknown> = {};
  let ok = true;
  const detailed = authorizeOpsRequest(request);

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
        owner: detailed ? lease.owner : leaseOwnerWithoutPid(lease.owner),
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
  // provider's key — a missing key is irrelevant unless that provider is the active one
  // (`activeEmbeddingProvider`, honoring a RAG_EMBED_PROVIDER pin).
  let ragEmbedProvider: RagEmbedRerankProvider | null = null;
  try {
    const pineconeKey = resolveApiKeyWithSource("pinecone");
    checks.pineconeConfigured = pineconeKey.source !== "none";

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
      const activeKeyConfigured = resolveApiKeyWithSource(ragEmbedProvider, "local").source !== "none";
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
    // "rag-embed"/"rag-rerank" (renamed 2026-07-19 from the historical "voyage"/"voyage-rerank"
    // service names — see withRagApiHealth in vector-db.ts) are now provider-generic: they ALWAYS
    // reflect whichever embed/rerank provider (Voyage, OpenRouter, SiliconFlow) is actually active,
    // so they can be unconditionally critical rather than only "critical while Voyage happens to be
    // the pin" (the old logic's gap — a dead OpenRouter/bge-m3 lane never failed liveness at all).
    // Still excluded when RAG_EMBED_PROVIDER is pinned-but-keyless (`ragEmbedProviderError` set):
    // that misconfiguration is already surfaced there, and 503ing the container on stale rag-embed/
    // rag-rerank rows from BEFORE the mis-pin would just restart-loop without fixing anything.
    const criticalServices = new Set(["pinecone", "alpaca-broker"]);
    if (!checks.ragEmbedProviderError) {
      criticalServices.add("rag-embed");
      criticalServices.add("rag-rerank");
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
      // rag-embed/rag-rerank criticality (bge-m3-metering-gate 2026-07-18, lane rename 2026-07-19):
      // these two lanes now gate liveness UNCONDITIONALLY (see the criticalServices comment above)
      // because the lane itself is provider-generic — a hard-stopped rag-embed lane means whichever
      // provider is actually active is down, which is always liveness-critical, not just when
      // Voyage happens to be the pin. Historical "voyage"/"voyage-rerank" rows (pre-rename, or from
      // recordMissingRagKey's still-literal-"voyage" missing-key path) are simply not in
      // criticalServices and degrade this route rather than 503 it — consistent with treating them
      // as legacy/informational once the real per-operation lane has taken over.
      const isCritical = criticalServices.has(summary.service);
      if (isCritical && hardStopped) {
        ok = false;
      }
    }
    checks.dependencies = dependencies;
  } catch {
    // never let connection health summaries break the health probe
  }

  // OpenRouter prepaid-credit balance. Universal routing (#1703) makes OpenRouter the single point
  // of failure for every LLM call AND all RAG embedding, so a drained balance = total decision-loop
  // outage (see docs/rollouts/2026-07-18-worktree-cleanup-voyage-rca.md). We surface the low-balance
  // SIGNAL on this PUBLIC probe so an EXTERNAL monitor (Uptime Robot) alerts when the money runs
  // low — a low balance sets dependencies.openrouter.ok=false (DEGRADE only; never 503, since a
  // restart can't refill credits and would just restart-loop). Cached + best-effort; a failed READ
  // never flips ok=false (see openrouter-credits.ts). Omitted entirely when no OpenRouter key is set.
  //
  // The USD FIGURES are operator-only (see the header comment) — the boolean is the alert, the
  // numbers are an attacker's countdown to a cheap total-outage window. `ok` MUST stay the first
  // serialized key of this object: the Uptime Robot keyword monitor matches the literal substring
  // `"openrouterCredits":{"ok":false` (docs/rollouts/2026-07-18-openrouter-credit-health-signal.md),
  // which is unchanged by this projection.
  try {
    const credits = await getOpenRouterCreditStatus();
    if (credits) {
      const deps = (checks.dependencies ?? {}) as Record<string, { ok: boolean; degraded?: boolean }>;
      const existing = deps.openrouter;
      deps.openrouter = {
        ok: (existing ? existing.ok : true) && credits.ok,
        degraded: (existing?.degraded) || (credits.ok ? undefined : true)
      };
      checks.dependencies = deps;
      checks.openrouterCredits = {
        ok: credits.ok,
        ...(detailed
          ? { remainingUsd: credits.remainingUsd, totalUsd: credits.totalUsd, usedUsd: credits.usedUsd }
          : {}),
        thresholdUsd: credits.thresholdUsd,
        checkedAt: credits.checkedAt,
        ...(credits.error ? { error: credits.error } : {})
      };
    }
  } catch {
    // never let the credit check break the health probe
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

    // Byte counts are operator-only (see the header comment); every litestream/backup-continuity
    // field below stays public because the credential-less deploy-verify runbook reads exactly
    // those, and `storageDegraded` (computed from the raw numbers, not from this object) keeps the
    // disk/WAL thresholds visible to an anonymous monitor without publishing the capacity itself.
    checks.storage = {
      ...(detailed ? { dbSizeBytes, walSizeBytes, freeBytes, totalBytes } : {}),
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
