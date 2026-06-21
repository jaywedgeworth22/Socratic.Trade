import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS } from "../src/lib/llm-request";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-red-team-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_URL;
});

describe("debateProposal — T11 fail-open contract", () => {
  // A red-team failure must NEVER silently reject (drop) a trade — it fails OPEN to rejected:false.
  const buyProposal = (): any => ({
    symbol: "AAPL",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "momentum",
    confidenceScore: 90,
    tradeThesisTag: "t",
    entryMarketRegime: "t"
  });

  it("fails open (does not reject) when OpenAI is not configured", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");
    delete process.env.OPENAI_API_KEY;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_NOKEY", paperMode: true });
    setStrategyPrompt("BASE STRATEGY");

    const result = await debateProposal(buyProposal(), undefined, true);
    expect(result.rejected).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it("fails open when the LLM request throws", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RT_THROW", paperMode: true });
    setStrategyPrompt("BASE STRATEGY");
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });

    const result = await debateProposal(buyProposal(), undefined, true);
    expect(result.rejected).toBe(false); // errored out → trade is not dropped by the red team
  });
});

describe("debateProposal LLM request bounds", () => {
  it("adds chat-completions output caps and deterministic sampling", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { debateProposal } = await import("../src/lib/red-team");

    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "RED-TEAM", paperMode: true });
    setStrategyPrompt("BASE STRATEGY");

    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ rejected: false, reason: "No fatal flaw found." })
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await debateProposal(
      {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        dollarAmount: 25,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "High-quality setup.",
        tradeThesisTag: "Quality-Compounder",
        entryMarketRegime: "Neutral (Normal Volatility)",
        confidenceScore: 90
      },
      undefined,
      true
    );

    expect(result).toEqual({ rejected: false, reason: "No fatal flaw found." });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_completion_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.redTeamDebate);
    expect(bodies[0].temperature).toBe(LLM_REQUEST_DEFAULTS.deterministicTemperature);
    expect(bodies[0].max_output_tokens).toBeUndefined();
  });
});
