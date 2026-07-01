import {
  isMobileCommandType,
  listMobileCommands,
  MobileCommandValidationError,
  processPendingMobileCommands,
  queueMobileCommand
} from "@/lib/mobile-api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status =
    rawStatus === "queued" || rawStatus === "running" || rawStatus === "succeeded" || rawStatus === "failed" || rawStatus === "cancelled"
      ? rawStatus
      : undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return NextResponse.json({ commands: listMobileCommands({ userId, status, limit }) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    commandType?: unknown;
    payload?: unknown;
    idempotencyKey?: unknown;
    client?: unknown;
  };
  const userId = resolveRequestUserId(request, body);
  const limited = enforceRateLimit(userId, "mobile/commands", { limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (!isMobileCommandType(body.commandType)) {
    return NextResponse.json({ error: "commandType is required or unsupported" }, { status: 400 });
  }

  try {
    const idempotencyKey = request.headers.get("idempotency-key") ?? body.idempotencyKey;
    const { command, deduped } = queueMobileCommand({
      userId,
      commandType: body.commandType,
      payload: body.payload,
      idempotencyKey,
      client: body.client
    });
    void processPendingMobileCommands({ limit: 3 }).catch((error) => console.error("[mobile] command worker kick failed:", error));
    return NextResponse.json({ command, deduped }, { status: deduped ? 200 : 202 });
  } catch (error) {
    const status = error instanceof MobileCommandValidationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid mobile command." }, { status });
  }
}
