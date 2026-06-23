/**
 * Tests for resolveLlmEndpoint — provider routing based on model name.
 * All tests run entirely offline (no real API key or network call required).
 */

import { beforeAll, describe, expect, it } from "vitest";
import os from "os";
import path from "path";

// Point the DB at a temp file before any imports touch it.
const tmpDb = path.join(os.tmpdir(), `llm-provider-test-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

describe("resolveLlmEndpoint", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolveLlmEndpoint: (policy?: any, userId?: string) => any;

  beforeAll(async () => {
    // Ensure DB is initialised before module import.
    const { getDb } = await import("../src/lib/db");
    getDb();
    const mod = await import("../src/lib/llm-provider");
    resolveLlmEndpoint = mod.resolveLlmEndpoint;
  });

  it("routes grok-4.3 to xAI with chat-completions transport", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-4.3" });
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.url).toContain("api.x.ai");
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("grok-4.3");
  });

  it("routes grok-build-0.1 to xAI (case-insensitive prefix match)", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "grok-build-0.1" });
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.url).toContain("api.x.ai");
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("grok-build-0.1");
  });

  it("routes gpt-5.4-mini to OpenAI", () => {
    const savedUrl = process.env.OPENAI_API_URL;
    delete process.env.OPENAI_API_URL;
    try {
      const endpoint = resolveLlmEndpoint({ llmModel: "gpt-5.4-mini" });
      expect(endpoint.provider).toBe("openai");
      expect(endpoint.url).toContain("api.openai.com");
      expect(endpoint.model).toBe("gpt-5.4-mini");
    } finally {
      if (savedUrl !== undefined) process.env.OPENAI_API_URL = savedUrl;
    }
  });

  it("routes empty/no policy to OpenAI (default model unchanged)", () => {
    const savedUrl = process.env.OPENAI_API_URL;
    delete process.env.OPENAI_API_URL;
    try {
      const endpoint = resolveLlmEndpoint({});
      expect(endpoint.provider).toBe("openai");
    } finally {
      if (savedUrl !== undefined) process.env.OPENAI_API_URL = savedUrl;
    }
  });

  it("uses XAI_API_URL override when set", () => {
    process.env.XAI_API_URL = "https://custom.xai.example.com/v1/chat/completions";
    try {
      const endpoint = resolveLlmEndpoint({ llmModel: "grok-4.3" });
      expect(endpoint.url).toBe("https://custom.xai.example.com/v1/chat/completions");
    } finally {
      delete process.env.XAI_API_URL;
    }
  });
});
