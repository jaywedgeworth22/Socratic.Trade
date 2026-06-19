import { NextResponse } from "next/server";
import { emitDashboardEvent, dashboardSubscriberCount } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Dev/ops route: emit a synthetic dashboard event to verify the SSE push path end-to-end
// (open /api/events/stream, hit this, watch the `dirty` event arrive). Gated to non-production
// unless ADMIN_REINDEX_TOKEN matches the x-admin-token header.
function authorized(request: Request): boolean {
  const token = process.env.ADMIN_REINDEX_TOKEN;
  if (token && request.headers.get("x-admin-token") === token) return true;
  return process.env.NODE_ENV !== "production";
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not authorized in production without ADMIN_REINDEX_TOKEN." }, { status: 403 });
  }
  const subscribers = dashboardSubscriberCount();
  emitDashboardEvent({ type: "dirty", at: new Date().toISOString(), detail: { test: true } });
  return NextResponse.json({ ok: true, emitted: "dirty", subscribers });
}
