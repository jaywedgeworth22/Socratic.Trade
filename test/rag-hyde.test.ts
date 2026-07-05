/**
 * hyde-multiquery-retrieval (2026-07-05): HyDE hypothetical-passage generation.
 *
 * `generateHydePassages` drafts 1-3 short hypothetical filing passages via ONE cheap LLM call —
 * default OFF (RAG_HYDE), fails open (returns []) on ANY error so a HyDE outage never blocks
 * retrieval. Mirrors test/salience-llm.test.ts's mocking pattern: mock `getPolicy`/`resolveLlmEndpoint`
 * so no live network/DB is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  resolveLlmEndpoint: vi.fn(),
  audit: vi.fn(),
  recordLlmUsage: vi.fn()
}));

vi.mock("../src/lib/db", () => ({
  getPolicy: mocks.getPolicy,
  audit: mocks.audit
}));

vi.mock("../src/lib/llm-provider", () => ({
  resolveLlmEndpoint: mocks.resolveLlmEndpoint
}));

vi.mock("../src/lib/llm-usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/llm-usage")>();
  return { ...actual, recordLlmUsage: mocks.recordLlmUsage };
});

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RAG_HYDE_MODEL;
  mocks.getPolicy.mockReturnValue({ llmModel: "gpt-5.4-mini" });
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.RAG_HYDE_MODEL;
});

describe("hydeEnabled (default-off flag)", () => {
  beforeEach(() => {
    delete process.env.RAG_HYDE;
  });
  afterEach(() => {
    delete process.env.RAG_HYDE;
  });

  it("is off by default", async () => {
    const { hydeEnabled } = await import("../src/lib/rag/multi-query");
    expect(hydeEnabled()).toBe(false);
  });
  it("turns on with RAG_HYDE=on", async () => {
    process.env.RAG_HYDE = "on";
    const { hydeEnabled } = await import("../src/lib/rag/multi-query");
    expect(hydeEnabled()).toBe(true);
  });
});

describe("generateHydePassages", () => {
  it("returns [] immediately for an empty queries array (no LLM call)", async () => {
    global.fetch = vi.fn(() => {
      throw new Error("should not be called for empty queries");
    }) as any;
    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages([]);
    expect(result).toEqual([]);
  });

  it("returns [] when no LLM credential resolves (no key)", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: undefined, model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => {
      throw new Error("should not be called with no key");
    }) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual([]);
    expect(mocks.recordLlmUsage).not.toHaveBeenCalled();
  });

  it("drafts passages and records LLM usage under context 'rag-hyde' on success", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", keyRef: "fp123", transport: "chat-completions" });
    const passages = ["Hypothetical risk-factor excerpt one.", "Hypothetical guidance excerpt two."];
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ passages }) } }],
          usage: { prompt_tokens: 120, completion_tokens: 80 }
        })
      })
    ) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors", "AAPL guidance"], { userId: "user-1" });

    expect(result).toEqual(passages);
    expect(mocks.recordLlmUsage).toHaveBeenCalledTimes(1);
    const call = mocks.recordLlmUsage.mock.calls[0][0];
    expect(call.context).toBe("rag-hyde");
    expect(call.userId).toBe("user-1");
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("gpt-5.4-mini");
    expect(call.promptTokens).toBe(120);
    expect(call.completionTokens).toBe(80);
  });

  it("respects RAG_HYDE_MODEL override", async () => {
    process.env.RAG_HYDE_MODEL = "gpt-5.4";
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn((_url: string, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe("gpt-5.4");
      return Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ passages: ["x"] }) } }] })
      });
    }) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual(["x"]);
  });

  it("returns [] and audits on a network error (fail-open, never throws)", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith("rag_hyde_failed", expect.objectContaining({ reason: expect.any(String) }), "local");
    expect(mocks.recordLlmUsage).not.toHaveBeenCalled();
  });

  it("returns [] on a non-OK HTTP response", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 429, json: async () => ({}) })) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual([]);
  });

  it("returns [] on malformed/unparseable JSON", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "not valid json {{{" } }] }) })
    ) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual([]);
  });

  it("caps at 3 passages even when the model returns more", async () => {
    mocks.resolveLlmEndpoint.mockReturnValue({ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "sk-test", model: "gpt-5.4-mini", keySource: "user", transport: "chat-completions" });
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ passages: ["a", "b", "c", "d", "e"] }) } }] })
      })
    ) as any;

    const { generateHydePassages } = await import("../src/lib/rag/multi-query");
    const result = await generateHydePassages(["AAPL risk factors"]);
    expect(result).toEqual(["a", "b", "c"]);
  });
});
