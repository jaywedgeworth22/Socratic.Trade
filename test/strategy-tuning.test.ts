import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS } from "../src/lib/llm-request";

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
    expect(proposal.summary).toContain("Collect more mock/local evidence");
    expect(proposal.proposedPatch.prompt).toContain("LEARNING LOOP");
    expect(proposal.cautions.join(" ")).toContain("Manual approval");
    expect(getStrategyPrompt()).toBe("BASE STRATEGY");
  });

  it("withholds factor-weight changes until 20 closed lots, even on weak performance", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    delete process.env.OPENAI_API_KEY;
    setStrategyPrompt("BASE STRATEGY");
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TUNE-GATE", paperMode: true, scoringWeights: { ...DEFAULT_POLICY.scoringWeights } });

    // 3 losing round-trips => 3 closed lots, negative average return (weak performance),
    // but far below the 20-lot gate, so factor weights must NOT be touched.
    let t = 0;
    for (const sym of ["AAA", "BBB", "CCC"]) {
      insertFillEvent({ accountNumber: "TUNE-GATE", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:00:${String(t++).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "TUNE-GATE", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: `2026-06-15T00:00:${String(t++).padStart(2, "0")}.000Z` });
    }

    const proposal = await proposeStrategyTuning();
    expect(proposal.generatedBy).toBe("local_rules");
    expect(proposal.proposedPatch.scoringWeights).toEqual({}); // gated — no weight shifts
    expect(proposal.cautions.join(" ")).toMatch(/closed lots/i);
  });

  it("sanitizes nullable LLM tuning fields and clamps confidence", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt } = await import("../src/lib/db");
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
    // Seed 20 closed lots so the §3.E weight-shift gate passes and the LLM's
    // sanitized scoringWeights survive (the gate is exercised separately below).
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const sym = `L${i}`;
      insertFillEvent({ accountNumber: "TUNE-LLM", source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(n / 60) }:${String(n++ % 60).padStart(2, "0")}.000Z` });
      insertFillEvent({ accountNumber: "TUNE-LLM", source: "paper", symbol: sym, side: "sell", quantity: 1, price: 110, notional: 110, status: "filled", filledAt: `2026-06-15T00:0${Math.floor(n / 60) }:${String(n++ % 60).padStart(2, "0")}.000Z` });
    }

    let sawMockLocalContext = false;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.max_output_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.strategyTuning);
      expect(body.temperature).toBe(LLM_REQUEST_DEFAULTS.deterministicTemperature);
      expect(body.max_completion_tokens).toBeUndefined();
      const context = JSON.parse(body.input.find((item: any) => item.role === "user")?.content ?? "{}");
      expect(context.activeMode).toBe("mock/local");
      expect(context.activeModeClarification).toContain("not Alpaca Paper");
      expect(context.policy.executionMode).toBe("mock/local");
      expect(context.policy.paperMode).toBeUndefined();
      expect(context.recentFills[0]?.source).toBe("mock/local");
      sawMockLocalContext = true;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Tune conservatively",
            rationale: "Recent mock/local performance supports modest tuning.",
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
      );
    });

    const proposal = await proposeStrategyTuning();

    expect(proposal.generatedBy).toBe("llm");
    expect(sawMockLocalContext).toBe(true);
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

  it("sends broker paper context for an Alpaca Paper account without calling it Mock/Local", async () => {
    const userId = `tune-broker-paper-${randomUUID()}`;
    const accountNumber = "TUNE-ALPACA-PAPER";
    const accountId = randomUUID();
    const { insertFillEvent, setActiveConnectedAccount, setPolicy, setStrategyPrompt, upsertConnectedAccount } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_API_URL = "https://api.openai.com/v1/responses";
    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber,
      label: "Alpaca Paper",
      isActive: true
    });
    setActiveConnectedAccount(accountId, userId);
    setStrategyPrompt("BROKER PAPER STRATEGY", userId);
    setPolicy({
      ...DEFAULT_POLICY,
      accountNumber,
      paperMode: false,
      activeBroker: "alpaca",
      scoringWeights: { ...DEFAULT_POLICY.scoringWeights }
    }, userId);
    insertFillEvent({
      userId,
      accountNumber,
      source: "live",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled"
    });

    let sawBrokerPaperContext = false;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const context = JSON.parse(body.input.find((item: any) => item.role === "user")?.content ?? "{}");
      expect(context.activeMode).toBe("broker/paper");
      expect(context.activeModeClarification).toContain("Alpaca Paper");
      expect(context.activeModeClarification).toContain("real capital is not at risk");
      expect(context.policy.executionMode).toBe("broker/paper");
      expect(context.policy.executionModeClarification).toContain("Alpaca Paper");
      expect(context.recentFills[0]?.source).toBe("broker/paper");
      sawBrokerPaperContext = true;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Review broker paper separately",
            rationale: "Broker paper fills are sandbox broker fills, not local simulator fills.",
            marketContext: "Macro is stable.",
            performanceReadout: "Continue gathering broker paper evidence.",
            proposedPrompt: "BROKER PAPER STRATEGY",
            scoringWeights: {
              liquidity: null,
              momentum: null,
              value: null,
              quality: null,
              volatility: null,
              sentiment: null,
              diversification: null
            },
            policy: {
              maxOrderNotional: null,
              maxDailyNotional: null,
              maxSymbolExposurePct: null,
              maxDailyOrders: null,
              maxProposalsPerRun: null,
              runCadenceMinutes: null,
              strategyAuthority: null,
              runDuringExtendedHours: null
            },
            riskRules: {
              stopLossPct: null,
              takeProfitPct: null,
              trailingStopPct: null
            },
            cautions: ["Keep broker paper separate from mock/local results."],
            confidenceScore: 80
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const proposal = await proposeStrategyTuning(userId);

    expect(proposal.generatedBy).toBe("llm");
    expect(sawBrokerPaperContext).toBe(true);
    expect(proposal.cautions.join(" ")).toContain("broker paper");
  });

  it("hard-strips LLM-proposed factor weights below the 20-lot gate, regardless of the prompt", async () => {
    const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_API_URL = "https://api.openai.com/v1/responses";
    setStrategyPrompt("CURRENT PROMPT");
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TUNE-LLM-GATE", paperMode: true, scoringWeights: { ...DEFAULT_POLICY.scoringWeights } });
    // No fills => 0 closed lots; even if the model ignores the prompt and returns weights, they must be stripped.
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          summary: "s", rationale: "r", marketContext: "m", performanceReadout: "p", proposedPrompt: "UPDATED",
          scoringWeights: { liquidity: 2.0, momentum: 1.5, value: null, quality: null, volatility: null, sentiment: null, diversification: null },
          policy: { maxOrderNotional: 15, maxDailyNotional: null, maxSymbolExposurePct: null, maxDailyOrders: null, maxProposalsPerRun: null, runCadenceMinutes: null, strategyAuthority: null, runDuringExtendedHours: null },
          riskRules: { stopLossPct: null, takeProfitPct: null, trailingStopPct: null },
          cautions: [], confidenceScore: 70
        })
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));

    const proposal = await proposeStrategyTuning();
    expect(proposal.generatedBy).toBe("llm");
    expect(proposal.proposedPatch.scoringWeights).toBeUndefined(); // gate stripped the weights
    expect(proposal.cautions.join(" ")).toMatch(/Withheld model-proposed factor-weight/i);
  });
});
