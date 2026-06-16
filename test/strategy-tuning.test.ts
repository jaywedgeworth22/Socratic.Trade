import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tuning-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_URL;
});

describe("proposeStrategyTuning", () => {
  it("returns a manual-review local fallback without mutating the prompt when OpenAI is not configured", async () => {
    const { insertFillEvent, getStrategyPrompt, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENAI_API_KEY;
    setStrategyPrompt("BASE STRATEGY");
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber: "TUNE-LOCAL",
      paperMode: true,
      maxOrderNotional: 25,
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    });
    insertFillEvent({
      accountNumber: "TUNE-LOCAL",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled"
    });

    const proposal = await proposeStrategyTuning();

    expect(proposal.generatedBy).toBe("local_rules");
    expect(proposal.summary).toContain("Collect more paper-trading evidence");
    expect(proposal.proposedPatch.prompt).toContain("LEARNING LOOP");
    expect(proposal.cautions.join(" ")).toContain("Manual approval");
    expect(getStrategyPrompt()).toBe("BASE STRATEGY");
  });

  it("sanitizes nullable LLM tuning fields and clamps confidence", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_API_URL = "https://api.openai.com/v1/responses";
    setStrategyPrompt("CURRENT PROMPT");
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber: "TUNE-LLM",
      paperMode: true,
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    });

    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          summary: "Tune conservatively",
          rationale: "Recent paper performance supports modest tuning.",
          marketContext: "Macro is stable.",
          performanceReadout: "Win rate is acceptable.",
          proposedPrompt: "UPDATED PROMPT",
          scoringWeights: {
            liquidity: 1.7,
            momentum: null,
            value: null,
            quality: 1.1,
            volatility: null,
            sentiment: 0.8,
            diversification: null
          },
          policy: {
            maxOrderNotional: 15,
            maxDailyNotional: null,
            maxSymbolExposurePct: null,
            maxDailyOrders: null,
            maxProposalsPerRun: null,
            runCadenceMinutes: null,
            universe: null,
            strategyAuthority: "propose",
            runDuringExtendedHours: false
          },
          riskRules: {
            stopLossPct: 5,
            takeProfitPct: null,
            trailingStopPct: null
          },
          cautions: ["Review before applying."],
          confidenceScore: 130
        })
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    const proposal = await proposeStrategyTuning();

    expect(proposal.generatedBy).toBe("llm");
    expect(proposal.confidenceScore).toBe(100);
    expect(proposal.proposedPatch).toEqual({
      prompt: "UPDATED PROMPT",
      scoringWeights: {
        liquidity: 1.7,
        quality: 1.1,
        sentiment: 0.8
      },
      policy: {
        maxOrderNotional: 15,
        strategyAuthority: "propose",
        runDuringExtendedHours: false,
        riskRules: {
          stopLossPct: 5
        }
      }
    });
  });
});
