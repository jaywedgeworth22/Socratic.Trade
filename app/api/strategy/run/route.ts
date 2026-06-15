import { runStrategyOnce } from "@/lib/strategy";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await runStrategyOnce();
  // audit("strategy_run", ...) is now written inside runStrategyOnce() so the
  // scheduler path also records it — no need to write it here.
  return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
}
