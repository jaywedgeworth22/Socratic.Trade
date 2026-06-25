import { resolveRequestUserId } from "@/lib/request-user";
import { buildProductionDeps, makeOrchestrator } from "@/lib/chat/orchestrator";
import { AnthropicLLM, getLLM, MockLLM, OpenAILLM, type LlmUsageOpts } from "@/lib/chat/llm";
import { resolveLlmCredential } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function usageOpts(userId: string, source: "user" | "operator" | "none", keyRef?: string): LlmUsageOpts {
  return { userId, keySource: source === "operator" ? "operator" : "user", keyRef, context: "chat" };
}

/**
 * Build an LLM from the per-request provider hint, scoped to `userId`. The key resolves
 * per-user-first with the operator env key as a flag-gated failover (resolveLlmCredential), and
 * usage is attributed to the user (per attached key). Returns null for an unrecognized hint so the
 * caller falls through to the env default (also per-user via getLLM(userId)).
 */
function llmFromProvider(hint: string | undefined, userId: string) {
  if (hint === "openai") {
    const { key, source, keyRef } = resolveLlmCredential("openai", userId);
    if (key) return new OpenAILLM(key, process.env.CHAT_LLM_MODEL ?? "gpt-4o-mini", undefined, usageOpts(userId, source, keyRef));
  }
  if (hint === "anthropic") {
    const { key, source, keyRef } = resolveLlmCredential("anthropic", userId);
    if (key) return new AnthropicLLM(key, process.env.CHAT_LLM_MODEL ?? "claude-opus-4-8", undefined, usageOpts(userId, source, keyRef));
  }
  if (hint === "mock") return new MockLLM();
  return null;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { message?: unknown; userId?: unknown; provider?: unknown };
  const userId = resolveRequestUserId(request, body);
  if (typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const providerHint = typeof body.provider === "string" ? body.provider : undefined;

  try {
    // Always per-user: an explicit provider hint, else the env-configured default keyed to this user.
    // (No shared singleton — that would pin one user's key/attribution for everyone.)
    const llm = llmFromProvider(providerHint, userId) ?? getLLM(userId);
    const orchestrate = makeOrchestrator(buildProductionDeps(), llm);
    const reply = await orchestrate({ userId, message: body.message });
    return NextResponse.json(reply);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[chat] orchestrator error:", message);
    // Single-operator app: forward the actual error (e.g. "invalid_api_key") so the
    // operator can act on it. Not a multi-user SaaS where internal details must be hidden.
    return NextResponse.json({ error: "chat_failed", message }, { status: 500 });
  }
}
