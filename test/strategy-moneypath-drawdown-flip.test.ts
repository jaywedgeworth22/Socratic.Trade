import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// G5 regression: the drawdown kill-switch WIRING inside runStrategyOnce.
//
// The pure/stateful breaker math is covered by test/risk-breaker.test.ts. This test covers the
// missing piece: that an autonomous, `active` run which observes an equity drop below the persisted
// high-water mark actually (a) flips systemState → "close_only" via setPolicy, and (b) writes an
// audit("policy_violation_drawdown") row — i.e. strategy.ts:~253-262 is correctly wired and durable
// (the HWM is read from the settings KV persisted across "restarts"). NEVER places a real trade.
vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-drawdown-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENAI_API_KEY;
});

function zeroProposalFetchStub() {
  return async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("api.openai.com")) {
      return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [] }) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("nasdaq.com")) {
      return new Response(
        JSON.stringify({
          data: {
            asof: "2026-06-30",
            table: { rows: [{ symbol: "AAPL", lastsale: "$200", pctchange: "1%", volume: "1000000", marketCap: "3000000000000", sector: "Technology", industry: "Consumer Electronics" }] }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  };
}

describe("runStrategyOnce drawdown kill-switch wiring (G5)", () => {
  it("flips an active autonomous run to close_only and audits policy_violation_drawdown on a breach", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", zeroProposalFetchStub());

    const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey, getPolicy, listAudit } = await import("../src/lib/db");
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");

    upsertUserApiKey("local", "openai", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test Account", isActive: true });
    setActiveConnectedAccount(accountId);

    // Persist a HIGH high-water mark for (local, TEST, paper) — as if a prior session peaked at
    // $250k. This lives in the settings KV, i.e. it survives a "restart" (a fresh module import).
    // The test-sim account equity is $100k, so the run observes a ~60% drawdown from this peak.
    const seeded = recordAndEvaluateDrawdownBreaker({
      accountNumber: "TEST",
      source: "paper",
      equity: 250_000,
      riskRules: { maxDrawdownPct: 20 },
      userId: "local"
    });
    expect(seeded.highWaterMark).toBe(250_000);
    expect(seeded.breached).toBe(false); // seeding the peak itself never breaches

    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      paperMode: true,
      llmModel: "gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      riskRules: { ...DEFAULT_POLICY.riskRules, maxDrawdownPct: 20 }
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // (a) systemState was flipped to close_only and persisted via setPolicy.
    expect(getPolicy("local").systemState).toBe("close_only");

    // (b) the breach was audited.
    const drawdownAudits = listAudit(500).filter((e) => e.kind === "policy_violation_drawdown");
    expect(drawdownAudits.length).toBeGreaterThanOrEqual(1);
    const payload = drawdownAudits[0].payload as { from?: string; revertedTo?: string; highWaterMark?: number };
    expect(payload.from).toBe("active");
    expect(payload.revertedTo).toBe("close_only");
    expect(payload.highWaterMark).toBe(250_000);
  }, 30_000);

  it("does NOT flip when no drawdown limit is configured (default-safe)", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", zeroProposalFetchStub());

    const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey, getPolicy, listAudit } = await import("../src/lib/db");
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");

    upsertUserApiKey("local", "openai", "test-openai-key", "test fixture");
    const accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId: "local", broker: "test", environment: "paper", accountNumber: "TEST", label: "Test Account", isActive: true });
    setActiveConnectedAccount(accountId);

    // Seed a high peak but WITHOUT a maxDrawdownPct limit → the breaker is a no-op even on a big drop.
    recordAndEvaluateDrawdownBreaker({ accountNumber: "TEST", source: "paper", equity: 250_000, riskRules: {}, userId: "local" });

    setPolicy({
      ...DEFAULT_POLICY,
      systemState: "active",
      paperMode: true,
      llmModel: "gpt-4.1-mini",
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      strategyAuthority: "decide",
      riskRules: {} // no drawdown/daily-loss limits
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    await runStrategyOnce();

    expect(getPolicy("local").systemState).toBe("active"); // unchanged
    expect(listAudit(500).filter((e) => e.kind === "policy_violation_drawdown").length).toBe(0);
  }, 30_000);
});
