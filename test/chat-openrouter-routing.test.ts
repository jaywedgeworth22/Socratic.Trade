/**
 * Regression coverage for review finding llm-12: the Coach (`llmForModel` in
 * `src/lib/chat/llm.ts`) used to resolve a model to its NATIVE provider family only, while the
 * strategy engine's `resolveLlmEndpoint` (`src/lib/llm-provider.ts`) already served every model
 * through an OpenRouter key first.  An owner with only an OpenRouter key attached saw "no key" for
 * every Coach model even though the same model already worked in the strategy engine, and
 * `/api/chat/providers` never reported OpenRouter availability at all.  `chatProviderForModel` also
 * had no llama -> meta mapping, so a llama model silently routed to OpenAI.
 *
 * These tests store credentials directly in the per-user key store (`upsertUserApiKey`) with
 * `LLM_OPERATOR_FALLBACK` forced off, rather than via env vars.  This sidesteps a NODE_ENV=test-only
 * shim in `resolveLlmCredential` (db-api-keys.ts) that lets an "openrouter" credential borrow ANY
 * single native-provider env var present when the operator failover is enabled — useful for OTHER
 * suites that want to exercise universal OpenRouter routing without configuring an explicit
 * OPENROUTER_API_KEY, but exactly the ambient leakage these tests need to avoid so "only a native
 * key is attached" and "only an OpenRouter key is attached" stay deterministic and mutually exclusive.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteUserApiKey, getDb, upsertUserApiKey } from "../src/lib/db";
import { AnthropicLLM, chatProviderForModel, llmForModel, MockLLM, OpenAILLM } from "../src/lib/chat/llm";
import { getLlmUsageSummary } from "../src/lib/llm-usage";
import { normalizeOpenRouterModelId, OPENROUTER_GEMINI_FLASH } from "../src/lib/llm-provider";
import type { LlmRunArgs } from "../src/lib/chat/types";

const noopExecuteTool = async (_name: string, _input: unknown) => ({ ok: true });
const baseArgs: LlmRunArgs = { system: "You are a trading assistant.", message: "Hello", tools: [], executeTool: noopExecuteTool };

/** Minimal chat-completions response shape so OpenAILLM.run() completes without a real network call. */
function fakeChatResponse(content = "ok") {
  return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
}

describe("llmForModel — OpenRouter-first routing (review finding llm-12)", () => {
  let savedFallback: string | undefined;

  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-openrouter-routing-${randomUUID()}.db`;
    getDb();
    savedFallback = process.env.LLM_OPERATOR_FALLBACK;
    // Force the operator-funded failover OFF so resolveLlmCredential never falls through to the
    // NODE_ENV=test borrow-any-key shim described above — every credential in this suite comes
    // from an explicit per-user store write, nothing ambient.
    process.env.LLM_OPERATOR_FALLBACK = "off";
  });

  afterAll(() => {
    if (savedFallback !== undefined) process.env.LLM_OPERATOR_FALLBACK = savedFallback;
    else delete process.env.LLM_OPERATOR_FALLBACK;
  });

  // (a) ── OpenRouter key present -> routes through OpenRouter with the normalized wire slug ────

  it("resolves a model via OpenRouter (not MockLLM) when only an OpenRouter key is attached", async () => {
    const userId = `u_or_${randomUUID()}`;
    upsertUserApiKey(userId, "openrouter", "sk-or-test-key");
    try {
      // "gemini-flash-latest" natively belongs to the "gemini" family (see chatProviderForModel),
      // and this user has NO gemini key stored — under the old native-only routing this would have
      // reported "no key" (MockLLM) even though OpenRouter can serve it.
      const llm = llmForModel("gemini-flash-latest", userId);
      expect(llm).toBeInstanceOf(OpenAILLM);
      expect(llm).not.toBeInstanceOf(MockLLM);
      // Wire model id must be normalized the SAME way the strategy engine normalizes it, so an
      // availability probe and the actual call can never disagree about a model's id.
      expect(llm.modelName).toBe(normalizeOpenRouterModelId("gemini-flash-latest"));
      expect(llm.modelName).toBe(OPENROUTER_GEMINI_FLASH);

      // Usage must still be recorded, and recorded against "openrouter" — the existing
      // recordLlmUsage/extractLlmUsage plumbing in chat/llm.ts must keep working unmodified.
      const fakeTransport = vi.fn().mockResolvedValue(fakeChatResponse());
      const llmWithTransport = llmForModel("gemini-flash-latest", userId, { openAITransport: fakeTransport });
      await llmWithTransport.run(baseArgs);
      expect(fakeTransport).toHaveBeenCalledOnce();
      const rows = getLlmUsageSummary({ userId });
      expect(rows.some((r) => r.provider === "openrouter")).toBe(true);
    } finally {
      deleteUserApiKey(userId, "openrouter");
    }
  });

  // (b) ── No OpenRouter key -> native-provider fallback is unchanged (no regression) ────────────

  it("falls back to the native provider when no OpenRouter key resolves (Anthropic)", () => {
    const userId = `u_native_anthropic_${randomUUID()}`;
    upsertUserApiKey(userId, "anthropic", "ant-test-key");
    try {
      const llm = llmForModel("claude-haiku-4-5", userId);
      expect(llm).toBeInstanceOf(AnthropicLLM);
    } finally {
      deleteUserApiKey(userId, "anthropic");
    }
  });

  it("falls back to the native provider when no OpenRouter key resolves (Gemini, OpenAI-compatible loop) and records that provider", async () => {
    const userId = `u_native_gemini_${randomUUID()}`;
    upsertUserApiKey(userId, "gemini", "gem-test-key");
    try {
      const fakeTransport = vi.fn().mockResolvedValue(fakeChatResponse());
      const llm = llmForModel("gemini-2.5-flash", userId, { openAITransport: fakeTransport });
      expect(llm).toBeInstanceOf(OpenAILLM);
      // Native path keeps the model id AS GIVEN (no OpenRouter normalization) — behavior unchanged.
      expect(llm.modelName).toBe("gemini-2.5-flash");
      await llm.run(baseArgs);
      const rows = getLlmUsageSummary({ userId });
      expect(rows.some((r) => r.provider === "gemini")).toBe(true);
      expect(rows.some((r) => r.provider === "openrouter")).toBe(false);
    } finally {
      deleteUserApiKey(userId, "gemini");
    }
  });

  it("still reports MockLLM (not an error) when NEITHER an OpenRouter key nor the native key resolves", () => {
    const userId = `u_none_${randomUUID()}`;
    expect(llmForModel("gpt-5.4-mini", userId)).toBeInstanceOf(MockLLM);
    expect(llmForModel("claude-haiku-4-5", userId)).toBeInstanceOf(MockLLM);
  });

  it("does not borrow an unrelated provider's key across families", () => {
    const userId = `u_wrong_family_${randomUUID()}`;
    upsertUserApiKey(userId, "openai", "oai-test-key");
    try {
      expect(llmForModel("gemini-2.5-flash", userId)).toBeInstanceOf(MockLLM);
      expect(llmForModel("claude-sonnet-4-6", userId)).toBeInstanceOf(MockLLM);
      expect(llmForModel("mistral-large-2512", userId)).toBeInstanceOf(MockLLM);
    } finally {
      deleteUserApiKey(userId, "openai");
    }
  });

  // (c) ── llama -> meta family mapping (was silently defaulting to "openai") ─────────────────────

  it("maps a llama model to the meta family, not openai", () => {
    expect(chatProviderForModel("llama-3.3-70b-instruct")).toBe("meta");
    expect(chatProviderForModel("meta-llama/llama-3.3-70b-instruct")).toBe("meta");
    expect(chatProviderForModel("llama-3.3-70b-instruct")).not.toBe("openai");
  });

  it("routes a llama model through a meta key (not an openai key) and records provider=meta", async () => {
    const userId = `u_meta_${randomUUID()}`;
    upsertUserApiKey(userId, "meta", "meta-test-key");
    try {
      const fakeTransport = vi.fn().mockResolvedValue(fakeChatResponse());
      const llm = llmForModel("llama-3.3-70b-instruct", userId, { openAITransport: fakeTransport });
      expect(llm).toBeInstanceOf(OpenAILLM);
      await llm.run(baseArgs);
      const rows = getLlmUsageSummary({ userId });
      expect(rows.some((r) => r.provider === "meta")).toBe(true);
    } finally {
      deleteUserApiKey(userId, "meta");
    }
  });

  it("a llama model with only an OpenAI key attached is MockLLM (confirms it no longer silently defaults to openai)", () => {
    const userId = `u_meta_wrong_key_${randomUUID()}`;
    upsertUserApiKey(userId, "openai", "oai-test-key");
    try {
      expect(llmForModel("llama-3.3-70b-instruct", userId)).toBeInstanceOf(MockLLM);
    } finally {
      deleteUserApiKey(userId, "openai");
    }
  });
});

// (d) ── /api/chat/providers reports OpenRouter availability ──────────────────────────────────────

describe("GET /api/chat/providers — OpenRouter row", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function callRoute(): Promise<Record<string, boolean>> {
    const { GET } = await import("../app/api/chat/providers/route");
    const res = await GET(new Request("http://localhost/api/chat/providers"));
    const body = (await res.json()) as { providers: Record<string, boolean> };
    return body.providers;
  }

  it("reports openrouter: true when an OpenRouter key resolves", async () => {
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "on");
    vi.stubEnv("OPENROUTER_API_KEY", "live-or-key");
    const providers = await callRoute();
    expect(providers.openrouter).toBe(true);
  });

  it("reports openrouter: false when no OpenRouter key resolves", async () => {
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const providers = await callRoute();
    expect(providers.openrouter).toBe(false);
  });
});
