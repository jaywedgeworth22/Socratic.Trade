import { proposeStrategyTuning } from "@/lib/strategy-tuning";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return NextResponse.json(await proposeStrategyTuning(resolveRequestUserId(request)));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Strategy tuning failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
