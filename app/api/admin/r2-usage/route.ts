import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { getR2UsageSnapshot, loadR2UsageMonitorConfig } from "@/lib/r2-usage";

export const dynamic = "force-dynamic";

/** Last R2 free-tier usage snapshot written by the scheduler lane — reads the
 *  persisted KV only, never calls Cloudflare on page load. */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const cfg = loadR2UsageMonitorConfig();
  const snapshot = getR2UsageSnapshot() ?? null;
  return NextResponse.json({
    configured: Boolean(cfg.token && cfg.accountId),
    intervalHours: cfg.intervalHours,
    thresholdPct: cfg.thresholdPct,
    bucketFilter: cfg.bucketFilter,
    snapshot,
  });
}
