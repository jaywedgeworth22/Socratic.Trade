// Round-3 Codex fixes verified at the two choke points:
//   X — the hard per-user/day LLM budget ceiling is enforced inside runStrategyOnce itself, so it
//       covers EVERY entry (event trigger, interval scheduler, manual "Run once" API, mobile command),
//       not just the trigger path.
//   Y — getBrokerGateway wraps placeEquityOrder with the live pre-flight guard, so every real-order
//       path (strategy, synthetic stops, protective stops, order replacement, future callers) is
//       covered by one shared wrapper.
// Temp SQLite per run per CLAUDE.md convention; no network (the guard throws before any broker call).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-choke-${randomUUID()}.db`)}`;
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
  delete process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD;
  delete process.env.ALLOW_LIVE_TRADING;
});
afterEach(() => {
  delete process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET;
  delete process.env.TRIGGER_LLM_DAILY_COST_BUDGET_USD;
  delete process.env.ALLOW_LIVE_TRADING;
});

async function seedUsage(userId: string, totalTokens: number): Promise<void> {
  const { getDb } = await import("../src/lib/db");
  getDb()
    .prepare(
      `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
       VALUES (?, ?, 'openai', 'gpt-4o', 'strategy', 'user', NULL, 0, ?, ?, NULL, ?)`
    )
    .run(randomUUID(), userId, totalTokens, totalTokens, new Date().toISOString());
}

describe("X — runStrategyOnce enforces the daily LLM budget at the choke point", () => {
  it("is a hard no-op (skips before lock/account/LLM) when over the configured token budget", async () => {
    process.env.TRIGGER_LLM_DAILY_TOKEN_BUDGET = "1000";
    await seedUsage("local", 1200);
    // manual:true is the "Run once" / mobile path — it must ALSO be gated by a hard ceiling.
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce("local", { manual: true });
    expect(result.status).toBe("failed");
    expect((result.summary ?? "").toLowerCase()).toContain("budget");

    const { getDb } = await import("../src/lib/db");
    const n = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'strategy_run_suppressed_budget'")
        .get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });
});

describe("Y — getBrokerGateway guards every real-order path", () => {
  it("blocks a broker/live placeEquityOrder when ALLOW_LIVE_TRADING is unset", async () => {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    const acctId = "acct-live-1";
    upsertConnectedAccount({
      id: acctId,
      userId: "local",
      broker: "robinhood",
      environment: "live",
      accountNumber: "LIVE-1",
      label: "Live",
      isActive: true
    });

    const { getBrokerGateway } = await import("../src/lib/broker");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const policy = {
      ...DEFAULT_POLICY,
      paperMode: false,
      activeBroker: "robinhood" as const,
      connectedAccountId: acctId,
      accountNumber: "LIVE-1"
    };

    const gateway = getBrokerGateway(policy, "local");
    // The guard throws BEFORE any Robinhood MCP call — no network, no real order. Assert on the
    // pre-flight block message + error name (robust across module boundaries).
    await expect(
      gateway.placeEquityOrder({ accountNumber: "LIVE-1", symbol: "AAPL", side: "buy", type: "market", quantity: 1, timeInForce: "gtc", marketHours: "regular_hours", refId: "guard-1" })
    ).rejects.toThrow(/pre-flight BLOCKED/i);
    await expect(
      gateway.placeEquityOrder({ accountNumber: "LIVE-1", symbol: "AAPL", side: "buy", type: "market", quantity: 1, timeInForce: "gtc", marketHours: "regular_hours", refId: "guard-2" })
    ).rejects.toMatchObject({ name: "LivePreflightError" });
  });
});
