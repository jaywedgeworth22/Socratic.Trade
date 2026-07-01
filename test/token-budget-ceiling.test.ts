// G8(a) — hard per-user/day LLM token-budget ceiling, checked at the trigger entry (src/lib/triggers.ts
// fire(), just before runStrategyOnce). Default OFF: TRIGGER_LLM_DAILY_TOKEN_BUDGET /
// TRIGGER_LLM_DAILY_COST_BUDGET_USD are both unset by default, so existing behavior is unchanged
// unless an operator opts in. Temp SQLite per run per CLAUDE.md convention.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runStrategyOnceMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/lib/strategy", () => ({
  runStrategyOnce: (...args: unknown[]) => runStrategyOnceMock(...args)
}));

// Market hours are wall-clock dependent; force "always open" so admitRun's market-hours check never
// blocks the budget-ceiling assertions below (that gate has its own coverage elsewhere).
vi.mock("../src/lib/market-hours", () => ({
  isRunAllowedNow: () => true
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-test-${randomUUID()}.db`)}`;
});

const ENV_KEYS = ["TRIGGER_ENGINE", "TRIGGER_MODE", "TRIGGER_LLM_DAILY_TOKEN_BUDGET", "TRIGGER_LLM_DAILY_COST_BUDGET_USD", "TRIGGER_GLOBAL_COOLDOWN_SEC", "TRIGGER_MAX_BATCH"];

beforeEach(() => {
  runStrategyOnceMock.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

async function seedUsage(userId: string, opts: { totalTokens?: number; costUsd?: number; createdAt?: Date } = {}): Promise<void> {
  const { getDb } = await import("../src/lib/db");
  const createdAt = (opts.createdAt ?? new Date()).toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
       VALUES (?, ?, 'openai', 'gpt-4o', 'strategy', 'user', NULL, ?, ?, ?, ?, ?)`
    )
    .run(randomUUID(), userId, opts.totalTokens ?? 0, 0, opts.totalTokens ?? 0, opts.costUsd ?? null, createdAt);
}

describe("checkLlmDailyBudget (G8a — pure ledger check)", () => {
  it("is a no-op (ok: true) by default, with both env limits unset", async () => {
    const { checkLlmDailyBudget } = await import("../src/lib/triggers");
    await seedUsage("user-default", { totalTokens: 10_000_000, costUsd: 9_999 });
    const decision = checkLlmDailyBudget("user-default");
    expect(decision.ok).toBe(true);
  });

  it("skips (ok: false) when today's token usage meets/exceeds a configured TRIGGER_LLM_DAILY_TOKEN_BUDGET", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000";
    const { checkLlmDailyBudget } = await import("../src/lib/triggers");
    await seedUsage("user-over-tokens", { totalTokens: 1200 });
    const decision = checkLlmDailyBudget("user-over-tokens");
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("token_budget");
    expect(decision.tokensToday).toBe(1200);
  });

  it("does not skip when today's usage is under the configured token budget", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000";
    const { checkLlmDailyBudget } = await import("../src/lib/triggers");
    await seedUsage("user-under-tokens", { totalTokens: 500 });
    const decision = checkLlmDailyBudget("user-under-tokens");
    expect(decision.ok).toBe(true);
  });

  it("skips when today's cost usage meets/exceeds a configured TRIGGER_LLM_DAILY_COST_BUDGET_USD", async () => {
    process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD = "5";
    const { checkLlmDailyBudget } = await import("../src/lib/triggers");
    await seedUsage("user-over-cost", { totalTokens: 100, costUsd: 7.5 });
    const decision = checkLlmDailyBudget("user-over-cost");
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("cost_budget");
  });

  it("only sums usage for the requested user, not other users", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000";
    const { checkLlmDailyBudget } = await import("../src/lib/triggers");
    await seedUsage("user-a", { totalTokens: 5000 });
    await seedUsage("user-b", { totalTokens: 10 });
    expect(checkLlmDailyBudget("user-a").ok).toBe(false);
    expect(checkLlmDailyBudget("user-b").ok).toBe(true);
  });

  it("only counts usage from today (America/New_York day boundary), not prior days", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000";
    const { checkLlmDailyBudget } = await import("../src/lib/triggers");
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await seedUsage("user-stale", { totalTokens: 5000, createdAt: yesterday });
    const decision = checkLlmDailyBudget("user-stale");
    expect(decision.ok).toBe(true);
    expect(decision.tokensToday).toBe(0);
  });
});

describe("trigger entry (fire) wired to the budget ceiling (G8a — end to end)", () => {
  async function activateUser(userId: string): Promise<void> {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const policy = getPolicy(userId);
    setPolicy({ ...policy, systemState: "active", accountNumber: "ACC-1", paperMode: true }, userId);
  }

  it("does NOT skip by default (limits unset) — runStrategyOnce still fires", async () => {
    process.env.TRIGGER_ENGINE = "true";
    process.env.TRIGGER_MODE = "event";
    process.env.TRIGGER_GLOBAL_COOLDOWN_SEC = "0";
    process.env.TRIGGER_MAX_BATCH = "1"; // fire immediately on the first event, no debounce wait
    const userId = `user-default-fire-${randomUUID()}`;
    await activateUser(userId);
    const { submitMaterialEvent } = await import("../src/lib/triggers");

    submitMaterialEvent(userId, { type: "test", sourceId: "s1" });
    await vi.waitFor(() => expect(runStrategyOnceMock).toHaveBeenCalledWith(userId));
  });

  it("skips + audits when the user is over a low configured token budget — runStrategyOnce never fires", async () => {
    process.env.TRIGGER_ENGINE = "true";
    process.env.TRIGGER_MODE = "event";
    process.env.TRIGGER_GLOBAL_COOLDOWN_SEC = "0";
    process.env.TRIGGER_MAX_BATCH = "1";
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "100";
    const userId = `user-over-budget-fire-${randomUUID()}`;
    await activateUser(userId);
    await seedUsage(userId, { totalTokens: 500 });
    const { submitMaterialEvent } = await import("../src/lib/triggers");

    submitMaterialEvent(userId, { type: "test", sourceId: "s2" });
    // Give the async fire() a tick to run and hit the (short-circuited) budget check.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runStrategyOnceMock).not.toHaveBeenCalledWith(userId);
  });

  it("records a trigger_suppressed_budget audit event when over budget", async () => {
    process.env.TRIGGER_ENGINE = "true";
    process.env.TRIGGER_MODE = "event";
    process.env.TRIGGER_GLOBAL_COOLDOWN_SEC = "0";
    process.env.TRIGGER_MAX_BATCH = "1";
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "100";
    const userId = `user-audit-fire-${randomUUID()}`;
    await activateUser(userId);
    await seedUsage(userId, { totalTokens: 999 });
    const { submitMaterialEvent } = await import("../src/lib/triggers");
    const { getDb } = await import("../src/lib/db");

    submitMaterialEvent(userId, { type: "test", sourceId: "s3" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = getDb()
      .prepare("SELECT kind, payload FROM audit_events WHERE user_id = ? AND kind = 'trigger_suppressed_budget'")
      .all(userId) as Array<{ kind: string; payload: string }>;
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.reason).toBe("token_budget");
    expect(runStrategyOnceMock).not.toHaveBeenCalledWith(userId);
  });
});
