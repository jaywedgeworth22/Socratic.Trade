import { proposeStrategyTuning } from "@/lib/strategy-tuning";
import { validateTuningInvariants } from "@/lib/tuning-invariants";
import { getPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body?.model === "string" ? body.model : undefined;
    const userId = resolveRequestUserId(request);
    const proposal = await proposeStrategyTuning(userId, model);
    // P0-3: in the MANUAL path, tuning-config invariant violations are surfaced as WARNINGS (never blocks) —
    // the human reviews them alongside the proposal. (The AUTONOMOUS path fails closed on the same set.)
    const invariants = validateTuningInvariants(getPolicy(userId).tuning);
    return NextResponse.json({
      ...proposal,
      ...(invariants.ok ? {} : { tuningConfigWarnings: invariants.violations })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Strategy tuning failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
