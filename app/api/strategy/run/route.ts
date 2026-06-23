import { runStrategyOnce } from "@/lib/strategy";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const body = await request.json().catch(() => ({})) as { manual?: boolean } | null;
  const result = await runStrategyOnce(userId, { manual: body?.manual === true });
  // audit("strategy_run", ...) is now written inside runStrategyOnce() so the
  // scheduler path also records it — no need to write it here.
  return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
}
