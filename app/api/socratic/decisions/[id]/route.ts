import { getSocraticDecisionCase, getStrategyRunById } from "@/lib/db";
import type { SocraticDecisionTrace } from "@/lib/types";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = resolveRequestUserId(request);
  const decision = getSocraticDecisionCase(id, userId);
  if (!decision) return NextResponse.json({ error: "decision not found" }, { status: 404 });
  const payload: SocraticDecisionTrace = {
    decision,
    ...(decision.runId ? { run: getStrategyRunById(decision.runId, userId) } : {})
  };
  return NextResponse.json(payload);
}
