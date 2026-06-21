import { resolveRequestUserId } from "@/lib/request-user";
import { notify } from "@/lib/notify";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  const results = await notify(userId, {
    title: "Test notification",
    body: "If you received this, your alert delivery channel is working.",
    kind: "test"
  });
  return NextResponse.json({ results });
}
