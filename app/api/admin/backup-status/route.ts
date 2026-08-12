import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { databasePath } from "@/lib/db";
import {
  assessLitestreamRuntimeHealth,
  assessLitestreamTierFreshness,
  defaultLitestreamStatePath,
  getLitestreamRuntimeHealth,
  runtimeReleaseIdentity,
  type LitestreamTierFreshness
} from "@/lib/runtime-health";

export const dynamic = "force-dynamic";

export interface BackupStatusPayload {
  liveMode: boolean;
  statePath: string;
  overall: {
    state: "known" | "unknown";
    status: string | null;
    lastSyncAt: string | null;
    ageSeconds: number | null;
    source: "ipc" | "file" | "none";
    degraded: boolean;
    reasons: string[];
  };
  tiers: LitestreamTierFreshness[];
  tiersDegraded: boolean;
  asOf: string;
}

/**
 * Admin-only view backing app/admin/backups/ — the same signals /api/health surfaces publicly
 * (checks.storage.litestream* + checks.storage.litestreamTiers), reshaped so the UI does not have
 * to reverse-engineer the public health-probe response. Read-only: no writes, no S3/B2 calls, no
 * SSH — same local IPC socket read + local file mtime scan the public probe already performs.
 */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const release = runtimeReleaseIdentity();
  const dbPath = databasePath();
  const liveMode = process.env.DB_BOOTSTRAP === "live";
  const statePath = process.env.LITESTREAM_STATE_PATH?.trim() || defaultLitestreamStatePath(dbPath);

  const freshness = await getLitestreamRuntimeHealth({
    dbPath,
    statePath,
    allowFileFallback: !liveMode
  });
  const assessment = assessLitestreamRuntimeHealth(freshness, {
    liveMode,
    processUptimeSeconds: release.processUptimeSeconds
  });
  const tierFreshness = assessLitestreamTierFreshness(statePath);

  const payload: BackupStatusPayload = {
    liveMode,
    statePath,
    overall: {
      state: freshness.state,
      status: freshness.state === "known" ? freshness.status : null,
      lastSyncAt: freshness.state === "known" ? freshness.lastSyncAt : null,
      ageSeconds: freshness.state === "known" ? freshness.ageSeconds : null,
      source: freshness.source,
      degraded: assessment.degraded,
      reasons: assessment.reasons
    },
    tiers: tierFreshness.tiers,
    tiersDegraded: tierFreshness.degraded,
    asOf: new Date().toISOString()
  };

  return NextResponse.json(payload, {
    status: 200,
    headers: { "Cache-Control": "private, no-store" }
  });
}
