import { runStrategyOnce } from "@/lib/strategy";
import { resolveRequestUserId } from "@/lib/request-user";
import { userHasAnyLlmCredential } from "@/lib/db";
import { LLM_REQUIRED_STRATEGY_MESSAGE } from "@/lib/llm-required";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  // A strategy session is LLM-driven: gate it on a resolvable LLM credential (the user's own key OR the
  // operator failover). Without one we 412 with an actionable message instead of running a loop that
  // would only error deep inside proposeTrades. `summary` keeps the client's existing error rendering.
  if (!userHasAnyLlmCredential(userId)) {
    return NextResponse.json({ status: "failed", summary: LLM_REQUIRED_STRATEGY_MESSAGE, proposals: [] }, { status: 412 });
  }
  const body = await request.json().catch(() => ({})) as { manual?: boolean } | null;
  const result = await runStrategyOnce(userId, { manual: body?.manual === true });
  // audit("strategy_run", ...) is now written inside runStrategyOnce() so the
  // scheduler path also records it — no need to write it here.
  return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
}
