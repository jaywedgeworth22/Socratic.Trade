import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DD_LLMOBS_DAILY_CAP,
  isLlmProviderUrl,
  resetDatadogLlmObsForTests,
  withDatadogLlmObs,
  datadogLlmObsEmittedForTests
} from "../src/lib/datadog-llmobs";

afterEach(() => {
  resetDatadogLlmObsForTests();
  vi.unstubAllEnvs();
  delete (globalThis as { _ddtrace?: unknown })._ddtrace;
});

describe("Datadog LLM Observability wrapper", () => {
  it("recognizes OpenRouter / OpenAI hosts and ignores Infisical", () => {
    expect(isLlmProviderUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(true);
    expect(isLlmProviderUrl("https://api.openai.com/v1/chat/completions")).toBe(true);
    expect(isLlmProviderUrl("https://app.infisical.com/api/v3/secrets")).toBe(false);
  });

  it("runs the fetch without wrapping when APM is off", async () => {
    vi.stubEnv("DD_TRACE_ENABLED", "false");
    const fn = vi.fn(async () => "ok");
    await expect(withDatadogLlmObs("https://openrouter.ai/api/v1/chat/completions", {}, fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("wraps an LLM fetch through dd-trace LLMObs when the tracer is present", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    const wrap = vi.fn((_opts: unknown, fn: () => Promise<unknown>) => async () => fn());
    (globalThis as { _ddtrace?: { llmobs: { wrap: typeof wrap } } })._ddtrace = { llmobs: { wrap } };
    const fn = vi.fn(async () => 42);
    await expect(
      withDatadogLlmObs(
        "https://openrouter.ai/api/v1/chat/completions",
        { body: JSON.stringify({ model: "x" }) },
        fn
      )
    ).resolves.toBe(42);
    expect(wrap).toHaveBeenCalledOnce();
    expect(wrap.mock.calls[0][0]).toMatchObject({
      kind: "llm",
      modelProvider: "openrouter",
      modelName: "x"
    });
    expect(datadogLlmObsEmittedForTests()).toBe(1);
  });

  it("stops wrapping after the daily Free-tier cap", async () => {
    vi.stubEnv("DD_API_KEY", "test-key");
    const wrap = vi.fn((_opts: unknown, fn: () => Promise<unknown>) => async () => fn());
    (globalThis as { _ddtrace?: { llmobs: { wrap: typeof wrap } } })._ddtrace = { llmobs: { wrap } };
    const url = "https://openrouter.ai/api/v1/chat/completions";
    for (let i = 0; i < DD_LLMOBS_DAILY_CAP + 3; i += 1) {
      await withDatadogLlmObs(url, {}, async () => i);
    }
    expect(wrap).toHaveBeenCalledTimes(DD_LLMOBS_DAILY_CAP);
  });
});
