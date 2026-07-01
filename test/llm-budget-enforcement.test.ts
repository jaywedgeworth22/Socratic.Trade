// Durable per-user/day LLM budget: modifiable per-user POLICY config (env fallback) + enforcement at
// the spend primitives (withLlmGeneration for all LLM generations, retrieveContextDetailed for RAG).
// Real temp DB per run (no db mock) so getPolicy / setPolicy / the usage ledger are exercised for real.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  // Reset the module cache so the db.ts singleton re-opens against THIS test's fresh temp file
  // (mirrors test/strategy-money-path-f-g.test.ts) — otherwise a stale connection leaks budget state.
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-budget-enf-${randomUUID()}.db`)}`;
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
  delete process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD;
});
afterEach(() => {
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
  delete process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD;
});

async function seedUsage(userId: string, totalTokens: number, costUsd?: number): Promise<void> {
  const { getDb } = await import("../src/lib/db");
  getDb()
    .prepare(
      `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
       VALUES (?, ?, 'openai', 'gpt-4o', 'strategy', 'user', NULL, 0, ?, ?, ?, ?)`
    )
    .run(randomUUID(), userId, totalTokens, totalTokens, costUsd ?? null, new Date().toISOString());
}
async function setTokenBudget(userId: string, tokenBudget: number): Promise<void> {
  const { getPolicy, setPolicy } = await import("../src/lib/db");
  const p = getPolicy(userId);
  setPolicy({ ...p, tuning: { ...p.tuning, llmDailyTokenBudget: tokenBudget } }, userId);
}

describe("LLM budget config — per-user POLICY (modifiable) with env fallback", () => {
  it("enforces a per-user policy budget with no env set (this is what the Settings UI writes)", async () => {
    await setTokenBudget("local", 1000);
    await seedUsage("local", 1200);
    const { checkLlmDailyBudget, isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(checkLlmDailyBudget("local").ok).toBe(false);
    expect(checkLlmDailyBudget("local").reason).toBe("token_budget");
    expect(isOverLlmBudget("local")).toBe(true);
  });

  it("policy budget takes precedence over the env default", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "100000"; // generous operator default
    await setTokenBudget("local", 1000); // stricter per-user override
    await seedUsage("local", 1200);
    const { isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(isOverLlmBudget("local")).toBe(true);
  });

  it("falls back to the env default when no policy budget is set", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000";
    await seedUsage("local", 1200);
    const { isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(isOverLlmBudget("local")).toBe(true);
  });

  it("is OFF by default (no policy value, no env) — never blocks", async () => {
    await seedUsage("local", 10_000_000, 9_999);
    const { isOverLlmBudget } = await import("../src/lib/llm-budget");
    expect(isOverLlmBudget("local")).toBe(false);
  });
});

describe("LLM budget — durable spend-primitive enforcement", () => {
  it("assertWithinLlmBudget throws LlmBudgetExceededError when over budget, no-ops when under", async () => {
    await setTokenBudget("local", 1000);
    await seedUsage("local", 1200);
    const { assertWithinLlmBudget, LlmBudgetExceededError } = await import("../src/lib/llm-budget");
    expect(() => assertWithinLlmBudget("local")).toThrow(LlmBudgetExceededError);
    expect(() => assertWithinLlmBudget("someone-else")).not.toThrow(); // different user, unlimited
  });

  it("withLlmGeneration refuses the model call when over budget (covers EVERY generation site)", async () => {
    await setTokenBudget("local", 1000);
    await seedUsage("local", 1200);
    const { withLlmGeneration } = await import("../src/lib/observability");
    let ran = false;
    await expect(
      withLlmGeneration({ name: "test.generation", model: "gpt-4o", userId: "local" }, async () => {
        ran = true;
        return "should-not-run";
      })
    ).rejects.toThrow(/budget ceiling/i);
    expect(ran).toBe(false);
  });

  it("withLlmGeneration runs normally when under budget", async () => {
    await setTokenBudget("local", 100000);
    await seedUsage("local", 10);
    const { withLlmGeneration } = await import("../src/lib/observability");
    const out = await withLlmGeneration({ name: "test.generation", model: "gpt-4o", userId: "local" }, async () => "ok");
    expect(out).toBe("ok");
  });

  it("retrieveContextDetailed skips RAG retrieval (returns []) when over budget — no Voyage/Pinecone spend", async () => {
    await setTokenBudget("local", 1000);
    await seedUsage("local", 1200);
    // Over budget returns BEFORE any client/embedding work, so this needs no Voyage/Pinecone mock.
    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("AAPL catalysts", "AAPL", 3, "local");
    expect(chunks).toEqual([]);
  });
});
