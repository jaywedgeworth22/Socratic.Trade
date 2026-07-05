import { getInternalSetting, getServiceHealthSummaries, databasePath, resolveApiKeyWithSource, alertStorageWarning } from "@/lib/db";
import { getProviderTierStatus } from "@/lib/provider-tier";
import { getLease } from "@/lib/scheduler-lease";
import { statSync, statfsSync, readdirSync } from "fs";
import { dirname, join } from "path";

export const dynamic = "force-dynamic";

function getLitestreamLastSyncAge(dbPath: string): number | null {
  const litestreamDir = `${dbPath}-litestream`;
  try {
    let newestMs = 0;
    const findNewest = (dir: string) => {
      const files = readdirSync(dir);
      for (const file of files) {
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          findNewest(fullPath);
        } else {
          if (stat.mtimeMs > newestMs) {
            newestMs = stat.mtimeMs;
          }
        }
      }
    };
    findNewest(litestreamDir);
    if (newestMs === 0) return null;
    return Math.round((Date.now() - newestMs) / 1000);
  } catch {
    return null;
  }
}

// Real liveness probe (was an unconditional {ok:true}). A health check that can never fail is
// worse than none for a system that can hold real positions — it hides outages. This probes:
//   - DB reachability (the getInternalSetting read throws if SQLite is unwritable/locked), and
//   - scheduler liveness (age of the last tick heartbeat; stale ⇒ autonomy/stops aren't running).
// Returns 503 when a critical check fails so PM2/uptime tooling can act.
export function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

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

  // Surface Pinecone and Voyage configuration status
  try {
    const pineconeKey = resolveApiKeyWithSource("pinecone");
    const voyageKey = resolveApiKeyWithSource("voyage");
    checks.pineconeConfigured = pineconeKey.source !== "none";
    checks.voyageConfigured = voyageKey.source !== "none";

    // If global keys are missing for critical dependencies, mark degraded
    if (pineconeKey.source === "none" || voyageKey.source === "none") {
      checks.ragConfigured = false;
    }
  } catch {
    // do not break health check on key resolution
  }

  // Surface every backend dependency from health summaries
  try {
    const summaries = getServiceHealthSummaries();
    const dependencies: Record<string, { ok: boolean; reason?: string | null; lastFailure?: string | null }> = {};
    for (const summary of summaries) {
      const isGlobal = summary.keySource === "env" || summary.keySource === "none" || summary.keySource === null;
      if (isGlobal) {
        dependencies[summary.service] = {
          ok: !summary.stoppedWorking,
          reason: summary.stoppedReason,
          lastFailure: summary.lastFailureError
        };

        // Critical dependencies fail the health check if they are stopped
        const isCritical = ["pinecone", "voyage", "voyage-rerank", "fmp", "massive", "alpaca-broker"].includes(summary.service);
        if (isCritical && summary.stoppedWorking) {
          ok = false;
        }
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

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(dbPath).size;
    } catch {}

    let walSizeBytes = 0;
    try {
      walSizeBytes = statSync(walPath).size;
    } catch {}

    let freeBytes = 0;
    let totalBytes = 0;
    try {
      const stats = statfsSync(dbDir);
      freeBytes = stats.bavail * stats.bsize;
      totalBytes = stats.blocks * stats.bsize;
    } catch {}

    const litestreamAgeSeconds = getLitestreamLastSyncAge(dbPath);

    checks.storage = {
      dbSizeBytes,
      walSizeBytes,
      freeBytes,
      totalBytes,
      litestreamAgeSeconds
    };

    // Thresholds:
    // Disk free space < 1 GB or WAL size > 500 MB or Litestream last-sync age > 1 hour (3600s)
    const diskLow = freeBytes > 0 && freeBytes < 1024 * 1024 * 1024;
    const walLarge = walSizeBytes > 500 * 1024 * 1024;
    const litestreamStale = litestreamAgeSeconds !== null && litestreamAgeSeconds > 3600;

    if (diskLow || walLarge || litestreamStale) {
      checks.storageDegraded = true;

      // Send a one-shot needs-attention notification/alert via the notifier if not sent recently
      if (diskLow) void alertStorageWarning("disk_space_low", `Free disk space is low: ${(freeBytes / 1024 / 1024).toFixed(2)} MB remaining.`);
      if (walLarge) void alertStorageWarning("wal_size_large", `SQLite WAL file size is large: ${(walSizeBytes / 1024 / 1024).toFixed(2)} MB.`);
      if (litestreamStale) void alertStorageWarning("litestream_replication_stale", `Litestream WAL replication has not synced in ${Math.round(litestreamAgeSeconds! / 60)} minutes.`);
    }
  } catch {
    // never let storage monitoring break the health probe
  }

  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
