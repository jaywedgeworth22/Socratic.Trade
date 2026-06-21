import { resolveRequestUserId } from "@/lib/request-user";
import { buildProductionDeps, makeOrchestrator } from "@/lib/chat/orchestrator";
import { AnthropicLLM, getLLM, MockLLM, OpenAILLM } from "@/lib/chat/llm";
import { resolveApiKey } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Lazy singleton for the default provider (driven by env). Per-request provider
// overrides construct a fresh instance each call — acceptable given low chat volume.
let defaultOrchestrate: ReturnType<typeof makeOrchestrator> | null = null;
function getDefaultOrchestrator() {
  if (!defaultOrchestrate) defaultOrchestrate = makeOrchestrator(buildProductionDeps());
  return defaultOrchestrate;
}

/** Build an LLM instance from the per-request provider hint. Falls through to the env default. */
function llmFromProvider(hint: string | undefined) {
  if (hint === "openai") {
    const key = resolveApiKey("openai");
    if (key) return new OpenAILLM(key, process.env.CHAT_LLM_MODEL ?? "gpt-4o-mini");
  }
  if (hint === "anthropic") {
    const key = resolveApiKey("anthropic");
    if (key) return new AnthropicLLM(key, process.env.CHAT_LLM_MODEL ?? "claude-opus-4-8");
  }
  if (hint === "mock") return new MockLLM();
  // No recognized hint — use the env-configured default.
  return null;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { message?: unknown; userId?: unknown; provider?: unknown };
  const userId = resolveRequestUserId(request, body);
  if (typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const providerHint = typeof body.provider === "string" ? body.provider : undefined;
  const llm = llmFromProvider(providerHint);

  // If the client sent an explicit provider that resolved to an LLM, use a fresh orchestrator for
  // this request. Otherwise fall through to the lazy singleton (env default).
  const orchestrate = llm
    ? makeOrchestrator(buildProductionDeps(), llm)
    : getDefaultOrchestrator();

  const reply = await orchestrate({ userId, message: body.message });
  return NextResponse.json(reply);
}
