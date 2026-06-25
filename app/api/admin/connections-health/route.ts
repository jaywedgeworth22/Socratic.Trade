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
  const limit = Number(url.searchParams.get("limit")) || 100;
  const offset = Number(url.searchParams.get("offset")) || 0;

  // When ?service= is provided, return paginated raw log for that service
  if (service) {
    const log = getServiceHealthLog(service, limit, offset);
    return NextResponse.json({ service, log, limit, offset });
  }

  const services = getServiceHealthSummaries();
  const errorPatterns = getAllErrorPatterns();

  return NextResponse.json({
    services,
    errorPatterns,
    asOf: new Date().toISOString(),
  });
}
