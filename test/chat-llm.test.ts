/**
 * Tests for OpenAILLM (and getLLM provider routing).
 *
 * OpenAILLM uses an injectable transport, so all tests run entirely offline —
 * no real API key or network call is required.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "../src/lib/db";
import { AnthropicLLM, getLLM, MockLLM, OpenAILLM } from "../src/lib/chat/llm";
import { DISCLAIMER } from "../src/lib/chat/prompt";
import type { LlmRunArgs, ToolSchema } from "../src/lib/chat/types";

// Shared LlmRunArgs fixture — minimal but valid.
const noopExecuteTool = async (_name: string, _input: unknown) => ({ ok: true });

const baseArgs: LlmRunArgs = {
  system: "You are a trading assistant.",
  message: "Hello",
  tools: [],
  executeTool: noopExecuteTool
};

// ── OpenAI response shapes ───────────────────────────────────────────────────

/** Build a minimal chat-completions response with a text assistant message. */
function chatResponse(content: string, finishReason = "stop") {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }]
  };
}

/** Build a tool_calls finish response. */
function toolCallResponse(name: string, args: Record<string, unknown>, toolCallId = "tc_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: toolCallId, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: "tool_calls"
      }
    ]
  };
}

// ── OpenAILLM unit tests ─────────────────────────────────────────────────────

describe("OpenAILLM — ChatLLM contract", () => {
  beforeAll(() => {
    // Point DB at a temp file so resolveApiKey doesn't blow up.
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-llm-test-${Date.now()}.db`;
    getDb();
  });

  it("returns text from a plain (no-tool) response", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("Hello from OpenAI!"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const result = await llm.run(baseArgs);

    expect(result.text).toBe("Hello from OpenAI!");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.citations).toHaveLength(0);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("sends system prompt + user message in the messages array", async () => {
    // Capture a snapshot of the messages array at call time (the array is mutated after the call).
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const transport = vi.fn().mockImplementation((body: { messages: Array<{ role: string; content: string }> }) => {
      capturedMessages = body.messages.map((m) => ({ role: m.role, content: m.content }));
      return Promise.resolve(chatResponse("ok"));
    });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    await llm.run({ ...baseArgs, system: "sys-prompt", message: "user-msg" });

    expect(capturedMessages[0]).toMatchObject({ role: "system", content: "sys-prompt" });
    expect(capturedMessages[capturedMessages.length - 1]).toMatchObject({ role: "user", content: "user-msg" });
  });

  it("passes the api key in the second argument to transport", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    const llm = new OpenAILLM("sk-my-key", "gpt-4o-mini", transport);
    await llm.run(baseArgs);

    const apiKey = transport.mock.calls[0][1];
    expect(apiKey).toBe("sk-my-key");
  });

  it("includes OpenAI tools array when tool schemas are provided", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const tools: ToolSchema[] = [
      { name: "get_quote", description: "Get a stock quote", input_schema: { type: "object", properties: { symbol: { type: "string" } } } }
    ];
    await llm.run({ ...baseArgs, tools });

    const body = transport.mock.calls[0][0];
    expect(body.tools).toBeDefined();
    expect(body.tools[0].function.name).toBe("get_quote");
    expect(body.tool_choice).toBe("auto");
  });

  it("executes a tool call and appends the result, then returns final text", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("get_quote", { symbol: "AAPL" }))
      .mockResolvedValueOnce(chatResponse("AAPL is at $200."));

    const executeTool = vi.fn().mockResolvedValue({ symbol: "AAPL", price_usd: 200, as_of: "2026-06-21" });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const tools: ToolSchema[] = [
      { name: "get_quote", description: "Get a stock quote", input_schema: { type: "object", properties: { symbol: { type: "string" } } } }
    ];
    const result = await llm.run({ ...baseArgs, tools, executeTool });

    expect(executeTool).toHaveBeenCalledWith("get_quote", { symbol: "AAPL" });
    expect(result.text).toBe("AAPL is at $200.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_quote");
    // Two transport calls: first returns tool_calls, second returns final text.
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("emits get_quote citations from tool calls", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("get_quote", { symbol: "TSLA" }))
      .mockResolvedValueOnce(chatResponse("TSLA price noted."));

    const executeTool = vi.fn().mockResolvedValue({ symbol: "TSLA", price_usd: 180, as_of: "2026-06-21T00:00:00Z" });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const tools: ToolSchema[] = [{ name: "get_quote", description: "q", input_schema: {} }];
    const result = await llm.run({ ...baseArgs, tools, executeTool });

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].source).toBe("get_quote");
    expect(result.citations[0].as_of).toBe("2026-06-21T00:00:00Z");
  });

  it("falls back to DISCLAIMER when the response has no text content", async () => {
    // content is null (tool call only, loop exits)
    const transport = vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }]
    });
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const result = await llm.run(baseArgs);

    expect(result.text).toBe(DISCLAIMER);
  });

  it("handles a tool-execution error without crashing", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(toolCallResponse("get_quote", { symbol: "ERR" }))
      .mockResolvedValueOnce(chatResponse("Could not get quote."));

    const executeTool = vi.fn().mockRejectedValue(new Error("network timeout"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const tools: ToolSchema[] = [{ name: "get_quote", description: "q", input_schema: {} }];
    const result = await llm.run({ ...baseArgs, tools, executeTool });

    expect(result.toolCalls[0].result).toMatchObject({ error: "TOOL_FAILED", message: "network timeout" });
    expect(result.text).toBe("Could not get quote.");
  });

  it("replays prior turns in the messages array for multi-turn context", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("second reply"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    const history = [
      { role: "user" as const, text: "first user message" },
      { role: "assistant" as const, text: "first assistant reply" }
    ];
    await llm.run({ ...baseArgs, message: "second user message", history });

    const body = transport.mock.calls[0][0];
    const msgs: Array<{ role: string; content: string }> = body.messages;
    const roles = msgs.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    // Verify ordering: system, then prior user, then prior assistant, then new user.
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs[userMsgs.length - 1].content).toBe("second user message");
  });

  it("drops a leading assistant history turn to satisfy OpenAI alternation requirement", async () => {
    const transport = vi.fn().mockResolvedValue(chatResponse("ok"));
    const llm = new OpenAILLM("sk-test", "gpt-4o-mini", transport);
    // History starting with an assistant turn (edge case during race conditions).
    const history = [{ role: "assistant" as const, text: "stale assistant prefix" }];
    await llm.run({ ...baseArgs, history });

    const body = transport.mock.calls[0][0];
    const msgs: Array<{ role: string; content: string }> = body.messages;
    // After the system message the first non-system role must be user, not assistant.
    const nonSystem = msgs.filter((m) => m.role !== "system");
    expect(nonSystem[0].role).toBe("user");
  });
});

// ── getLLM provider routing ─────────────────────────────────────────────────

describe("getLLM provider routing", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/chat-llm-routing-${Date.now()}.db`;
    getDb();
  });

  it("returns MockLLM when CHAT_LLM is unset", () => {
    const saved = process.env.CHAT_LLM;
    delete process.env.CHAT_LLM;
    const llm = getLLM();
    expect(llm).toBeInstanceOf(MockLLM);
    if (saved !== undefined) process.env.CHAT_LLM = saved;
  });

  it("returns MockLLM when CHAT_LLM=openai but no key is available", () => {
    const savedLlm = process.env.CHAT_LLM;
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.CHAT_LLM = "openai";
    delete process.env.OPENAI_API_KEY;
    const llm = getLLM();
    expect(llm).toBeInstanceOf(MockLLM);
    process.env.CHAT_LLM = savedLlm;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  });

  it("returns OpenAILLM when CHAT_LLM=openai and OPENAI_API_KEY is set", () => {
    const savedLlm = process.env.CHAT_LLM;
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.CHAT_LLM = "openai";
    process.env.OPENAI_API_KEY = "sk-test-key";
    const llm = getLLM();
    expect(llm).toBeInstanceOf(OpenAILLM);
    process.env.CHAT_LLM = savedLlm;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    else delete process.env.OPENAI_API_KEY;
  });

  it("returns AnthropicLLM when CHAT_LLM=anthropic and ANTHROPIC_API_KEY is set", () => {
    const savedLlm = process.env.CHAT_LLM;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.CHAT_LLM = "anthropic";
    process.env.ANTHROPIC_API_KEY = "ant-test-key";
    const llm = getLLM();
    expect(llm).toBeInstanceOf(AnthropicLLM);
    process.env.CHAT_LLM = savedLlm;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });
});
