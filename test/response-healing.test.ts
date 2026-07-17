import { describe, it, expect, vi, beforeEach } from "vitest";
import { healMalformedJson } from "../src/lib/response-healing";
import * as llmRequest from "../src/lib/llm-request";

vi.mock("../src/lib/observability", () => ({
  withLlmGeneration: vi.fn(async (opts, fn) => fn())
}));

vi.mock("../src/lib/llm-request", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/llm-request")>();
  return {
    ...actual,
    fetchLlmWithRetry: vi.fn()
  };
});

describe("healMalformedJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("successfully heals malformed JSON using the LLM", async () => {
    const brokenJson = `{"proposals": [{"symbol": "AAPL", "side": "buy"`; // missing closing brackets
    const expectedHealedJson = `{"proposals": [{"symbol": "AAPL", "side": "buy"}]}`;

    vi.mocked(llmRequest.fetchLlmWithRetry).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: expectedHealedJson }
          }
        ]
      })
    } as unknown as Response);

    const result = await healMalformedJson(brokenJson, { userId: "user_123" });
    
    expect(result).toBe(expectedHealedJson);
    expect(llmRequest.fetchLlmWithRetry).toHaveBeenCalledTimes(1);
    
    // Assert the LLM was called with the right prompt
    const callArgs = vi.mocked(llmRequest.fetchLlmWithRetry).mock.calls[0];
    expect(callArgs[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    
    const bodyStr = (callArgs[1]?.body as string) || "";
    expect(bodyStr).toContain("You are a strict JSON repair tool");
    expect(bodyStr).toContain("AAPL");
  });

  it("returns undefined if the LLM response is not valid JSON", async () => {
    const brokenJson = `{"proposals": [{"symbol": "AAPL", "side": "buy"`;

    vi.mocked(llmRequest.fetchLlmWithRetry).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: "I am unable to fix this JSON because I am an AI." }
          }
        ]
      })
    } as unknown as Response);

    const result = await healMalformedJson(brokenJson, {});
    expect(result).toBeUndefined();
  });

  it("returns undefined if the LLM network request fails", async () => {
    const brokenJson = `{"bad": true`;

    vi.mocked(llmRequest.fetchLlmWithRetry).mockResolvedValueOnce({
      ok: false,
      status: 500
    } as unknown as Response);

    const result = await healMalformedJson(brokenJson, {});
    expect(result).toBeUndefined();
  });
});
