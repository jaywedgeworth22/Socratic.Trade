import { NextResponse } from "next/server";
import { admitRun, submitMaterialEvent, triggerEngineEnabled, triggerMode } from "@/lib/triggers";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Dev/ops route to inspect the event-driven trigger engine and preview the admitRun gate.
// GET = show engine state + the admit decision for a sample event. POST = submit a test event
// (no-op unless TRIGGER_ENGINE=on and mode != interval). Gated to non-production.
function authorized(request: Request): boolean {
  const token = process.env.ADMIN_REINDEX_TOKEN;
  if (token && request.headers.get("x-admin-token") === token) return true;
  return process.env.NODE_ENV !== "production";
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const userId = resolveRequestUserId(request);
  return NextResponse.json({
    ok: true,
    engineEnabled: triggerEngineEnabled(),
    mode: triggerMode(),
    admitPreview: admitRun(userId, [{ type: "test", symbol: "AAPL", sourceId: "diagnostic" }])
  });
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const userId = resolveRequestUserId(request);
  let symbol = "AAPL";
  try {
    const body = (await request.json()) as { symbol?: string };
    if (body?.symbol) symbol = String(body.symbol);
  } catch {
    // default
  }
  submitMaterialEvent(userId, { type: "test", symbol, sourceId: `diagnostic-${symbol}-${Date.now()}` });
  return NextResponse.json({
    ok: true,
    submitted: { symbol },
    engineEnabled: triggerEngineEnabled(),
    mode: triggerMode(),
    note: "Event submitted. No-op unless TRIGGER_ENGINE=on and mode != interval; gated by admitRun."
  });
}
