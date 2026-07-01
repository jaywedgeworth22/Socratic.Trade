import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import { applyCongressEvent, applyCongressEvents, type CongressEvent } from "@/lib/congress-trade-events";
import { verifyCongressWebhookSecret } from "@/lib/congress-webhook-auth";
import { logApiHealth } from "@/lib/db-health";

export const dynamic = "force-dynamic";

// Inbound receiver for congress.trade (App A) push events (see docs/push-to-app-b.md).
// Auth: a shared bearer secret (CONGRESS_WEBHOOK_SECRET) verified constant-time. Rejects all writes
// when no secret is configured. Accepts a single event envelope or { events: [...] } for batches.
// Always returns fast and never throws into the app; events are idempotent (deduped by id).
export async function POST(req: Request) {
  if (!verifyCongressWebhookSecret(req)) {
    audit("congress_webhook_rejected", { reason: "secret" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  try {
    // Freshness signal for the admin Connections page: an authenticated webhook
    // was received from App A over the push channel.
    logApiHealth({ service: "congress.trade:webhook", ok: true });
    const rec = body && typeof body === "object" ? (body as { events?: unknown }) : null;
    if (rec && Array.isArray(rec.events)) {
      const results = applyCongressEvents(rec.events);
      return NextResponse.json({ ok: true, count: results.length, results });
    }
    const result = applyCongressEvent(body as CongressEvent);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    audit("congress_webhook_error", { error: error instanceof Error ? error.message : "unknown" });
    logApiHealth({
      service: "congress.trade:webhook",
      ok: false,
      errorText: error instanceof Error ? error.message : "ingest failed",
    });
    return NextResponse.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
}
