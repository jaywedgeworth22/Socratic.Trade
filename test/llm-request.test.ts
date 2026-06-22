import { describe, expect, it, afterEach, vi } from "vitest";
import {
  isReasoningModel,
  resolveOpenAiModel,
  withLlmRequestBounds,
  DEFAULT_OPENAI_MODEL
} from "../src/lib/llm-request";

describe("llm-request — model resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("classifies reasoning vs classic models", () => {
    expect(isReasoningModel("gpt-5.4-mini")).toBe(true);
    expect(isReasoningModel("gpt-5.5")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
    expect(isReasoningModel("gpt-4.1-mini")).toBe(false);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel(undefined)).toBe(false);
  });

  it("resolves per-user policy model over env over default", () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-4.1-mini");
    expect(resolveOpenAiModel({ llmModel: "gpt-5.5" })).toBe("gpt-5.5");
    expect(resolveOpenAiModel({ llmModel: "  " })).toBe("gpt-4.1-mini"); // blank policy → env
    expect(resolveOpenAiModel(null)).toBe("gpt-4.1-mini");
    vi.unstubAllEnvs();
    expect(resolveOpenAiModel(null)).toBe(DEFAULT_OPENAI_MODEL);
  });
});

describe("llm-request — withLlmRequestBounds", () => {
  it("classic models keep temperature and exact token cap (no reasoning_effort)", () => {
    const chat = withLlmRequestBounds({ model: "gpt-4.1-mini" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "gpt-4.1-mini"
    });
    expect(chat.temperature).toBe(0);
    expect(chat.max_completion_tokens).toBe(1500);
    expect("reasoning_effort" in chat).toBe(false);

    const resp = withLlmRequestBounds({ model: "gpt-4.1-mini" }, "responses", {
      maxOutputTokens: 1500,
      model: "gpt-4.1-mini"
    });
    expect(resp.temperature).toBe(0);
    expect(resp.max_output_tokens).toBe(1500);
    expect("reasoning" in resp).toBe(false);
  });

  it("reasoning models drop temperature, add reasoning_effort, and raise the token cap", () => {
    const chat = withLlmRequestBounds({ model: "gpt-5.4-mini" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium"
    });
    expect("temperature" in chat).toBe(false);
    expect(chat.reasoning_effort).toBe("medium");
    expect(chat.max_completion_tokens).toBe(1500 + 4000); // medium headroom

    const resp = withLlmRequestBounds({ model: "gpt-5.5" }, "responses", {
      maxOutputTokens: 1500,
      model: "gpt-5.5",
      reasoningEffort: "low"
    });
    expect("temperature" in resp).toBe(false);
    expect(resp.reasoning).toEqual({ effort: "low" });
    expect(resp.max_output_tokens).toBe(1500 + 2000); // low headroom
  });

  it("reasoning models default to medium effort when unspecified", () => {
    const chat = withLlmRequestBounds({ model: "gpt-5.4-nano" }, "chat-completions", {
      maxOutputTokens: 1000,
      model: "gpt-5.4-nano"
    });
    expect(chat.reasoning_effort).toBe("medium");
    expect(chat.max_completion_tokens).toBe(1000 + 4000);
  });
});
