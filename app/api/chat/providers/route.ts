import { resolveRequestUserId } from "@/lib/request-user";
import { resolveLlmCredential } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/providers — per-provider key availability for the Assistant model picker.
 * Returns ONLY booleans (never the key) so the dropdown can mark a provider whose key isn't
 * resolvable for this user. "Resolvable" uses resolveLlmCredential — the same check llmForModel
 * makes to decide real-vs-mock — so a provider shows available whenever the app can actually serve
 * it for this user. No distinction is drawn here between a user's own key and any other resolved key.
 */
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const services = ["openai", "anthropic", "xai", "gemini", "mistral", "deepseek", "moonshot"] as const;
  const providers: Record<string, boolean> = {};
  for (const service of services) providers[service] = Boolean(resolveLlmCredential(service, userId).key);
  return NextResponse.json({ providers });
}
