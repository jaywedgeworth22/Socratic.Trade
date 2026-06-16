import { proposeStrategyTuning } from "@/lib/strategy-tuning";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return NextResponse.json(await proposeStrategyTuning());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Strategy tuning failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
