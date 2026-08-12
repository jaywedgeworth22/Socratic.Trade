import { NextRequest, NextResponse } from "next/server";
import { setApiKeyPaused, isApiKeyPaused, LOCAL_USER } from "@/lib/db-api-keys";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { service?: string; isPaused?: boolean; userId?: string };
    const service = body.service?.trim();
    if (!service) {
      return NextResponse.json({ ok: false, error: "service parameter is required" }, { status: 400 });
    }

    const userId = body.userId || LOCAL_USER;
    const isPaused = body.isPaused === true;

    setApiKeyPaused(userId, service, isPaused);
    const updatedStatus = isApiKeyPaused(userId, service);

    return NextResponse.json({
      ok: true,
      service,
      userId,
      isPaused: updatedStatus,
      message: updatedStatus
        ? `API key for ${service} has been PAUSED. The system will dynamically utilize available fallbacks.`
        : `API key for ${service} has been RESUMED and is active.`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
