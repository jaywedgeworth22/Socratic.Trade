import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import {
  recordTradingViewSignal,
  technicalEnabled,
  verifyWebhookSecret,
  type TradingViewWebhookPayload
} from "@/lib/web-sources/technical";

export const dynamic = "force-dynamic";

// Inbound receiver for TradingView Pine `alert()` webhooks (the "push" technical-signal
// producer). TradingView does NOT sign payloads, so security is layered:
//   1. a shared secret embedded in the JSON body, verified constant-time server-side;
//   2. an optional IP allowlist (TRADINGVIEW_WEBHOOK_IPS) — note: behind a tunnel the
//      visible IP is the tunnel's, so this is opt-in and off by default;
//   3. dedup on (symbol|signals|bar_time) inside recordTradingViewSignal.
// Always returns fast and never throws into the app. Paper-mode safe: it only writes a
// technical signal into the cache; it places no orders and bypasses no policy gate.

function clientIp(req: Request): string | undefined {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim();
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? undefined;
}

function ipAllowed(req: Request): boolean {
  const raw = process.env.TRADINGVIEW_WEBHOOK_IPS;
  if (!raw) return true; // allowlist not configured → IP check disabled
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const ip = clientIp(req);
  return !!ip && allowed.includes(ip);
}

export async function POST(req: Request) {
  if (!technicalEnabled()) {
    return NextResponse.json({ ok: false, error: "technical source disabled" }, { status: 404 });
  }
  if (!ipAllowed(req)) {
    audit("tradingview_webhook_rejected", { reason: "ip", ip: clientIp(req) });
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Pine `alert()` sends the message as the raw request body; content-type is not
  // guaranteed to be application/json, so read text and parse defensively.
  let payload: TradingViewWebhookPayload;
  try {
    const text = await req.text();
    payload = JSON.parse(text) as TradingViewWebhookPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!verifyWebhookSecret(payload.secret)) {
    audit("tradingview_webhook_rejected", { reason: "secret", symbol: payload.symbol });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = recordTradingViewSignal(payload);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.warning ?? "rejected" }, { status: 422 });
    }
    return NextResponse.json({ ok: true, symbol: result.symbol, deduped: result.deduped ?? false });
  } catch (error) {
    audit("tradingview_webhook_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
}
