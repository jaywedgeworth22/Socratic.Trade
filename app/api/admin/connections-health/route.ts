import { NextResponse } from "next/server";
import {
  getServiceHealthSummaries,
  getServiceHealthLog,
  getAllErrorPatterns,
} from "@/lib/db-health";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const service = url.searchParams.get("service");
  const keySourceParam = url.searchParams.has("keySource") ? url.searchParams.get("keySource") : undefined;
  const limit = Number(url.searchParams.get("limit")) || 100;
  const offset = Number(url.searchParams.get("offset")) || 0;

  // When ?service= is provided, return paginated raw log for that credential lane
  if (service) {
    const log = getServiceHealthLog(service, limit, offset, keySourceParam);
    return NextResponse.json({ service, keySource: keySourceParam ?? null, log, limit, offset });
  }

  const services = getServiceHealthSummaries();
  const errorPatterns = getAllErrorPatterns();

  return NextResponse.json({
    services,
    errorPatterns,
    asOf: new Date().toISOString(),
  });
}
