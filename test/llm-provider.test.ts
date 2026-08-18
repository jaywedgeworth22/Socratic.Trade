/**
 * Tests for resolveLlmEndpoint — provider routing based on model name.
 * All tests run entirely offline (no real API key or network call required).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

// Point the DB at a temp file before any imports touch it.
const tmpDb = path.join(os.tmpdir(), `llm-provider-test-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

describe("resolveLlmEndpoint", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveLlmEndpoint: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setApiKey: (...args: any[]) => any;

  beforeAll(async () => {
    // Ensure DB is initialised before module import.
    const { getDb } = await import("../src/lib/db");
    getDb();
    const dbApiKeys = await import("../src/lib/db-api-keys");
    setApiKey = dbApiKeys.upsertUserApiKey;
    const mod = await import("../src/lib/llm-provider");
    resolveLlmEndpoint = mod.resolveLlmEndpoint;
  });

  it("routes to OpenRouter when user has an OpenRouter key", () => {
    setApiKey("test-user-or", "openrouter", "sk-or-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "test-user-or");
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(endpoint.key).toBe("sk-or-test-key");
    expect(endpoint.model).toBe("anthropic/claude-sonnet-5");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls back to native Anthropic endpoint when user has an Anthropic key but no OpenRouter key", () => {
    setApiKey("test-user-anthropic", "anthropic", "sk-ant-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "test-user-anthropic");
    expect(endpoint.provider).toBe("anthropic");
    expect(endpoint.url).toBe("https://api.anthropic.com/v1/messages");
    expect(endpoint.key).toBe("sk-ant-test-key");
    expect(endpoint.model).toBe("claude-sonnet-5");
    expect(endpoint.transport).toBe("anthropic-messages");
  });

  it("falls back to native xAI endpoint when user has an xAI key but no OpenRouter key", () => {
    setApiKey("test-user-xai", "xai", "xai-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-4.5" }, "test-user-xai");
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(endpoint.key).toBe("xai-test-key");
    expect(endpoint.model).toBe("grok-4.5");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls back to native Moonshot endpoint when user has a Moonshot key but no OpenRouter key", () => {
    setApiKey("test-user-moonshot", "moonshot", "sk-moonshot-test-key");
    const endpoint = resolveLlmEndpoint({ llmModel: "kimi-latest" }, "test-user-moonshot");
    expect(endpoint.provider).toBe("moonshot");
    expect(endpoint.url).toBe("https://api.moonshot.cn/v1/chat/completions");
    expect(endpoint.key).toBe("sk-moonshot-test-key");
    expect(endpoint.model).toBe("kimi-latest");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("fails closed (key undefined) when user has no keys at all", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-sonnet-5" }, "user-with-no-keys");
    expect(endpoint.key).toBeUndefined();
  });

  it("maps Flash-class aliases to current OpenRouter Gemini 3.7 Flash", async () => {
    const { normalizeOpenRouterModelId, OPENROUTER_GEMINI_FLASH, OPENROUTER_GEMINI_FLASH_BATCH } =
      await import("../src/lib/llm-provider");
    expect(normalizeOpenRouterModelId("gemini-flash-latest")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-flash-latest")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-3.6-flash")).toBe(OPENROUTER_GEMINI_FLASH);
    expect(normalizeOpenRouterModelId("google/gemini-3.6-flash:batch")).toBe(OPENROUTER_GEMINI_FLASH_BATCH);
    expect(normalizeOpenRouterModelId("gemini-3.5-flash")).toBe("google/gemini-3.5-flash");
    expect(normalizeOpenRouterModelId("google/gemini-3.7-flash")).toBe(OPENROUTER_GEMINI_FLASH);
  });

  it("maps Mistral Medium to the dash OpenRouter slug, never the period form", async () => {
    const { normalizeOpenRouterModelId } = await import("../src/lib/llm-provider");
    expect(normalizeOpenRouterModelId("mistral-medium-latest")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistral-medium-3-5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistral-medium-3.5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistralai/mistral-medium-3.5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("mistralai/mistral-medium-3-5")).toBe("mistralai/mistral-medium-3-5");
    expect(normalizeOpenRouterModelId("gpt-5.4-nano")).toBe("openai/gpt-5.4-nano");
  });

  it("emits live OpenRouter public ids, never the untilded -latest 404s", async () => {
    // Verified GET https://openrouter.ai/api/v1/models 2026-08-18 (413 models).
    const { normalizeOpenRouterModelId } = await import("../src/lib/llm-provider");
    const cases: Array<[string, string]> = [
      ["claude-sonnet-5", "anthropic/claude-sonnet-5"],
      ["claude-sonnet-latest", "anthropic/claude-sonnet-5"],
      ["anthropic/claude-sonnet-latest", "anthropic/claude-sonnet-5"],
      ["~anthropic/claude-sonnet-latest", "anthropic/claude-sonnet-5"],
      ["openrouter/~anthropic/claude-sonnet-latest", "anthropic/claude-sonnet-5"],
      ["claude-haiku-4.5", "anthropic/claude-haiku-4.5"],
      ["claude-haiku-latest", "anthropic/claude-haiku-4.5"],
      ["anthropic/claude-haiku-latest", "anthropic/claude-haiku-4.5"],
      ["~anthropic/claude-haiku-latest", "anthropic/claude-haiku-4.5"],
      ["claude-opus-5", "anthropic/claude-opus-5"],
      ["claude-opus-latest", "anthropic/claude-opus-5"],
      ["anthropic/claude-opus-latest", "anthropic/claude-opus-5"],
      ["~anthropic/claude-opus-latest", "anthropic/claude-opus-5"],
      ["claude-fable-5", "anthropic/claude-fable-5"],
      ["claude-fable-latest", "anthropic/claude-fable-5"],
      ["anthropic/claude-fable-latest", "anthropic/claude-fable-5"],
      ["~anthropic/claude-fable-latest", "anthropic/claude-fable-5"],
      ["grok-4.5", "x-ai/grok-4.5"],
      ["grok-latest", "x-ai/grok-4.5"],
      ["x-ai/grok-latest", "x-ai/grok-4.5"],
      ["~x-ai/grok-latest", "x-ai/grok-4.5"],
      ["gpt-5.4-mini", "openai/gpt-5.4-mini"],
      ["gpt-mini-latest", "openai/gpt-5.4-mini"],
      ["openai/gpt-mini-latest", "openai/gpt-5.4-mini"],
      ["~openai/gpt-mini-latest", "openai/gpt-5.4-mini"],
      ["kimi-latest", "~moonshotai/kimi-latest"],
      ["moonshotai/kimi-latest", "~moonshotai/kimi-latest"],
      ["~moonshotai/kimi-latest", "~moonshotai/kimi-latest"],
      ["deepseek-reasoner", "deepseek/deepseek-r1"],
      ["deepseek/deepseek-reasoner", "deepseek/deepseek-r1"],
      ["deepseek-r1", "deepseek/deepseek-r1"]
    ];
    for (const [input, expected] of cases) {
      expect(normalizeOpenRouterModelId(input), input).toBe(expected);
    }
    expect(normalizeOpenRouterModelId("anthropic/claude-sonnet-latest")).not.toBe("anthropic/claude-sonnet-latest");
    expect(normalizeOpenRouterModelId("x-ai/grok-latest")).not.toBe("x-ai/grok-latest");
    expect(normalizeOpenRouterModelId("openai/gpt-mini-latest")).not.toBe("openai/gpt-mini-latest");
    expect(normalizeOpenRouterModelId("moonshotai/kimi-latest")).not.toBe("moonshotai/kimi-latest");
    expect(normalizeOpenRouterModelId("deepseek/deepseek-reasoner")).not.toBe("deepseek/deepseek-reasoner");
  });
});
