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
  let resolveLlmEndpoint: (...args: any[]) => any;

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

  it("routes gemini-2.5-flash to Gemini's OpenAI-compat endpoint (chat-completions)", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "gemini-2.5-flash" });
    expect(endpoint.provider).toBe("gemini");
    expect(endpoint.url).toContain("generativelanguage.googleapis.com");
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("gemini-2.5-flash");
  });

  it("routes mistral-large-latest to Mistral (chat-completions)", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "mistral-large-latest" });
    expect(endpoint.provider).toBe("mistral");
    expect(endpoint.url).toContain("api.mistral.ai");
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("mistral-large-latest");
  });

  it("routes the Mistral family (ministral/codestral) to Mistral", () => {
    expect(resolveLlmEndpoint({ llmModel: "ministral-8b-latest" }).provider).toBe("mistral");
    expect(resolveLlmEndpoint({ llmModel: "codestral-latest" }).provider).toBe("mistral");
  });

  it("honors GEMINI_API_URL / MISTRAL_API_URL overrides", () => {
    const savedG = process.env.GEMINI_API_URL;
    const savedM = process.env.MISTRAL_API_URL;
    process.env.GEMINI_API_URL = "https://gw.example/gemini/chat/completions";
    process.env.MISTRAL_API_URL = "https://gw.example/mistral/chat/completions";
    try {
      expect(resolveLlmEndpoint({ llmModel: "gemini-3.5-flash" }).url).toBe("https://gw.example/gemini/chat/completions");
      expect(resolveLlmEndpoint({ llmModel: "mistral-medium-latest" }).url).toBe("https://gw.example/mistral/chat/completions");
    } finally {
      if (savedG === undefined) delete process.env.GEMINI_API_URL; else process.env.GEMINI_API_URL = savedG;
      if (savedM === undefined) delete process.env.MISTRAL_API_URL; else process.env.MISTRAL_API_URL = savedM;
    }
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

  it("routes the Red Team through redTeamLlmModel when configured", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini", redTeamLlmModel: "grok-4.3" },
      "local",
      "https://api.openai.com/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("xai");
    expect(endpoint.model).toBe("grok-4.3");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("falls Red Team back to the Green model when no red override is set", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini" },
      "local",
      "https://api.openai.com/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("openai");
    expect(endpoint.model).toBe("gpt-5.4-mini");
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
