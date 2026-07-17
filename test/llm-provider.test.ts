import { describe, expect, it } from "vitest";
import { resolveLlmEndpoint } from "../src/lib/llm-provider";

describe("resolveLlmEndpoint", () => {
  it("routes models to openrouter by default", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "gpt-4o" });
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toContain("openrouter.ai");
    expect(endpoint.transport).toBe("chat-completions");
    // Vendor-namespaced WIRE id (Codex on PR #1703): OpenRouter rejects bare model ids.
    expect(endpoint.model).toBe("openai/gpt-4o");
  });

  it("routes claude to openrouter", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "claude-3-opus-20240229" });
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toContain("openrouter.ai");
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("anthropic/claude-3-opus-20240229");
  });

  it("routes gemini to openrouter", () => {
    const endpoint = resolveLlmEndpoint({ llmModel: "gemini-1.5-pro-preview-0409" });
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.url).toContain("openrouter.ai");
    expect(endpoint.transport).toBe("chat-completions");
    expect(endpoint.model).toBe("google/gemini-1.5-pro-preview-0409");
  });

  it("routes the Red Team through redTeamLlmModel when configured", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini", redTeamLlmModel: "grok-4.3" },
      "local",
      "https://api.openai.com/v1/responses",
      "red"
    );
    expect(endpoint.provider).toBe("openrouter");
    // x-ai/ is OpenRouter's Grok namespace — `xai/` would be an invalid model id.
    expect(endpoint.model).toBe("x-ai/grok-4.3");
    expect(endpoint.transport).toBe("chat-completions");
  });

  it("resolves the Red Team to \"\" (unconfigured) when no redTeamLlmModel is set", () => {
    const endpoint = resolveLlmEndpoint(
      { llmModel: "gpt-5.4-mini" },
      "local",
      "https://api.openai.com/v1/responses",
      "red"
    );
    expect(endpoint.model).toBe("");
  });

  it("routes empty/no policy to the openrouter branch with an unconfigured (\"\") model", () => {
    const endpoint = resolveLlmEndpoint({});
    expect(endpoint.provider).toBe("openrouter");
    expect(endpoint.model).toBe("");
  });
});
