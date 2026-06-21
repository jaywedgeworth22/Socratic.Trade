import { resolveRequestUserId } from "@/lib/request-user";
import { buildProductionDeps, makeOrchestrator } from "@/lib/chat/orchestrator";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Lazy singleton so importing the route never touches the DB/LLM config at build time.
let orchestrate: ReturnType<typeof makeOrchestrator> | null = null;
function getOrchestrator() {
  if (!orchestrate) orchestrate = makeOrchestrator(buildProductionDeps());
  return orchestrate;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { message?: unknown; userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  if (typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  const reply = await getOrchestrator()({ userId, message: body.message });
  return NextResponse.json(reply);
}
