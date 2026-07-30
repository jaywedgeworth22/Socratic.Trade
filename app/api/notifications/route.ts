import { resolveRequestUserId } from "@/lib/request-user";
import { getNotifyPrefs, setNotifyPrefs } from "@/lib/db";
import { describeChannels } from "@/lib/notify";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json({ channels: describeChannels(), prefs: getNotifyPrefs(userId) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    channels?: unknown;
    pushTarget?: unknown;
    pushoverTarget?: unknown;
    webhookUrl?: unknown;
    email?: unknown;
    phone?: unknown;
    userId?: unknown;
  };
  const userId = resolveRequestUserId(request, body);
  return NextResponse.json({ prefs: setNotifyPrefs(userId, body) });
}
