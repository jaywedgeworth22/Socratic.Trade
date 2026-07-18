import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { detectLlmTruncation } from "../src/lib/llm-call";

// Item 5 (Chat A): a Bull answer that hits the output-token cap truncates its JSON, fails to parse,
// and yields zero proposals. That must be DISTINGUISHED from a genuine "do nothing" — never a silent
// no-op.

describe("detectLlmTruncation (Chat A item 5)", () => {
  it("detects an OpenAI chat-completions finish_reason=length", () => {
    expect(detectLlmTruncation({ choices: [{ finish_reason: "length", message: { content: "{" } }] })).toBe(true);
  });
  it("detects an Anthropic stop_reason=max_tokens", () => {
    expect(detectLlmTruncation({ stop_reason: "max_tokens" })).toBe(true);
  });
  it("detects the OpenAI responses API incomplete/max_output_tokens shape", () => {
    expect(detectLlmTruncation({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).toBe(true);
    expect(detectLlmTruncation({ output: [{ status: "incomplete" }] })).toBe(true);
  });
  it("returns false for a complete response or non-object input", () => {
    expect(detectLlmTruncation({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] })).toBe(false);
    expect(detectLlmTruncation({ stop_reason: "end_turn" })).toBe(false);
    expect(detectLlmTruncation({ status: "completed" })).toBe(false);
    expect(detectLlmTruncation(null)).toBe(false);
    expect(detectLlmTruncation("not-an-object")).toBe(false);
  });
});

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-bull-trunc-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function nasdaqRow(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Bull truncation is not a silent no-op (Chat A item 5)", () => {
  it("records a strategy_bull_truncated audit + step reason when the Bull response hits the cap", async () => {
    // vi.stubEnv so afterEach(vi.unstubAllEnvs) restores these — a leaked OPENROUTER_API_URL would break
    // other files' Bull-body assertions when vitest shares a process across test files.
    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    // chat-completions transport so the mock can return a finish_reason=length truncation signal.
    vi.stubEnv("OPENROUTER_API_URL", "https://openrouter.ai/v1/chat/completions");
    let openAiCalls = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const href = String(url);
      if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
        openAiCalls += 1;
        if (openAiCalls === 1) {
          // Truncated Bull: finish_reason "length" with cut-off, unparseable JSON content.
          return new Response(
            JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"proposals":[{"symbol":"AAPL","sid' } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        // Any later call (e.g. the Bear reviewing an empty set) returns a clean empty result.
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"proposals":[]}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (href.includes("nasdaq.com")) return nasdaqRow();
      return new Response("not found", { status: 404 });
    });

    const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey, listAudit } = await import("../src/lib/db");
    upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Truncation Test", isActive: true });
    setActiveConnectedAccount(accountId);
    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      llmModel: "openai/gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide"
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();

    // The run completes (a truncated Bull is not a hard failure) but with zero proposals...
    expect(result.status).toBe("completed");
    // ...and the truncation is recorded distinctly, not swallowed as a silent no-op.
    const runKinds = listAudit(500)
      .filter((e) => (e.payload as { runId?: string })?.runId === result.runId)
      .map((e) => e.kind);
    expect(runKinds).toContain("strategy_bull_truncated");
    const bullStep = result.llmSteps?.find((s) => s.step === "bull");
    expect(bullStep?.reason ?? "").toMatch(/truncat/i);
  }, 30_000);
});
