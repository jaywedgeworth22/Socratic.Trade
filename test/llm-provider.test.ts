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
    expect(endpoint.model).toBe("anthropic/claude-sonnet-latest");
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
});
