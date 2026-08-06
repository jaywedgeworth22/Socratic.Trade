import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

const tmpDir = path.join(os.tmpdir(), `trading-test-usage-budget-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

const budget = await import("../src/lib/usage-budget");
const { DEFAULT_POLICY } = await import("../src/lib/defaults");
const { listNotificationEvents } = await import("../src/lib/db-notifications");

const BASE = "https://usage.example.test";
const TOKEN = "test-token";

type BudgetStatus = Awaited<ReturnType<typeof budget.getBudgetStatusCached>>;

function status(providers: Array<{
  name: string;
  status: "ok" | "warning" | "exceeded" | "unconfigured";
  spentUsd?: number;
  monthlyBudgetUsd?: number;
  projectedEomUsd?: number | null;
  projectedRunoutDate?: string | null;
  spendCoverage?: string | null;
}>): NonNullable<BudgetStatus> {
  return {
    generatedAt: new Date().toISOString(),
    month: "2026-07",
    providers: providers.map((p) => ({
      name: p.name,
      status: p.status,
      monthlyBudgetUsd: p.monthlyBudgetUsd ?? 100,
      spentUsd: p.spentUsd ?? 0,
      remainingUsd: null,
      percentUsed: null,
      projectedEomUsd: p.projectedEomUsd ?? null,
      projectedRunoutDate: p.projectedRunoutDate ?? null,
      spendCoverage: p.spendCoverage ?? null,
    })),
    summary: {
      totalBudgetUsd: 100,
      totalSpentUsd: 0,
      remainingUsd: 100,
      percentUsed: 0,
      overBudget: providers.some((p) => p.status === "exceeded"),
      warning: providers.some((p) => p.status === "warning"),
    },
  };
}

describe("usage-budget: cheaperModel", () => {
  it("maps known models down a tier and returns undefined when none", () => {
    expect(budget.cheaperModel("openai/gpt-4o")).toBe("openai/gpt-5.4-mini");
    expect(budget.cheaperModel("anthropic/claude-opus-4-8")).toBe("anthropic/claude-sonnet-4-6");
    expect(budget.cheaperModel("claude-haiku-4-5-20251001")).toBeUndefined(); // already cheapest (prefix)
    expect(budget.cheaperModel("openai/gpt-5.4-nano")).toBeUndefined();
    expect(budget.cheaperModel(undefined)).toBeUndefined();
  });
});

describe("usage-budget: evaluateBudgetForRun", () => {
  beforeEach(() => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_BUDGET_ENFORCE = "on";
  });
  afterEach(() => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_BUDGET_ENFORCE;
  });

  it("downgrades the model when the LLM provider is over budget", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o", redTeamLlmModel: "openai/gpt-4o" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(true);
    expect(decision.llmModel).toBe("openai/gpt-5.4-mini");
    expect(decision.redTeamLlmModel).toBe("openai/gpt-5.4-mini");
  });

  it("skips the cycle when over budget and already on the cheapest tier", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-5.4-nano" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(true);
    expect(decision.downgraded).toBe(false);
  });

  it("still skips when green is cheapest even if the red model could be downgraded (F6)", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-5.4-nano", redTeamLlmModel: "anthropic/claude-opus-4-8" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(true);
    expect(decision.downgraded).toBe(false);
  });

  it("makes NO decision when policy.llmModel is unset — the run fails closed before any spend (no-defaults)", async () => {
    // No llmModel → resolves to "" (owner directive 2026-07-07: no model default for anything,
    // ever); the run never sends an LLM request, so there is nothing to budget or downgrade.
    const decision = await budget.evaluateBudgetForRun(
      "local",
      {},
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
    expect(decision.llmModel).toBeUndefined();
  });

  it("does nothing when the LLM provider is under budget", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o" },
      { status: status([{ name: "openai", status: "ok" }, { name: "alpaca", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });

  it("is a no-op (fail-open) when enforcement is disabled", async () => {
    process.env.USAGE_BUDGET_ENFORCE = "off";
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o" },
      { status: status([{ name: "openai", status: "exceeded" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });

  it("is a no-op when budget status is unavailable (monitor down)", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o" },
      { status: null }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(false);
  });

  it("enforces on openrouter when spend is booked there (universal routing)", async () => {
    // After #1703 all strategy LLM spend is provider openrouter even for gpt-* model ids.
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-5.4-nano" },
      { status: status([{ name: "openrouter", status: "exceeded" }, { name: "openai", status: "ok" }]) }
    );
    expect(decision.skip).toBe(true);
    expect(decision.downgraded).toBe(false);
    expect(decision.reason).toMatch(/openrouter/i);
  });

  it("downgrades using openrouter status when present even if family lane is ok", async () => {
    const decision = await budget.evaluateBudgetForRun(
      "local",
      { llmModel: "openai/gpt-4o", redTeamLlmModel: "openai/gpt-4o" },
      { status: status([{ name: "openrouter", status: "exceeded" }, { name: "openai", status: "ok" }]) }
    );
    expect(decision.skip).toBe(false);
    expect(decision.downgraded).toBe(true);
    expect(decision.llmModel).toBe("openai/gpt-5.4-mini");
  });
});

describe("usage-budget: getBudgetStatusCached", () => {
  afterEach(() => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
  });

  it("fetches + parses the monitor response with bearer auth", async () => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    let capturedAuth: string | null = null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth = headers?.authorization ?? null;
      return new Response(JSON.stringify(status([{ name: "anthropic", status: "warning" }])), { status: 200 });
    }) as unknown as typeof fetch;

    const s = await budget.getBudgetStatusCached({ force: true, fetchImpl });
    expect(capturedAuth).toBe(`Bearer ${TOKEN}`);
    expect(s?.providers[0]?.name).toBe("anthropic");
    expect(s?.providers[0]?.status).toBe("warning");
  });

  it("returns null when unconfigured", async () => {
    const s = await budget.getBudgetStatusCached({ force: true });
    expect(s).toBeNull();
  });

  it("parses projectedEomUsd/projectedRunoutDate/spendCoverage forecast fields when present", async () => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    const raw = {
      generatedAt: new Date().toISOString(),
      month: "2026-07",
      providers: [
        {
          name: "openai",
          status: "ok",
          monthlyBudgetUsd: 100,
          spentUsd: 20,
          remainingUsd: 80,
          percentUsed: 20,
          projectedEomUsd: 145.5,
          projectedRunoutDate: "2026-07-22",
          spendCoverage: "complete",
        },
      ],
      summary: { totalBudgetUsd: 100, totalSpentUsd: 20, remainingUsd: 80, percentUsed: 20, overBudget: false, warning: false },
    };
    const fetchImpl = (async () => new Response(JSON.stringify(raw), { status: 200 })) as unknown as typeof fetch;

    const s = await budget.getBudgetStatusCached({ force: true, fetchImpl });
    expect(s?.providers[0]?.projectedEomUsd).toBe(145.5);
    expect(s?.providers[0]?.projectedRunoutDate).toBe("2026-07-22");
    expect(s?.providers[0]?.spendCoverage).toBe("complete");
  });

  it("defaults forecast fields to null when the monitor response omits them (older monitor)", async () => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    const fetchImpl = (async () => new Response(JSON.stringify(status([{ name: "openai", status: "ok" }])), { status: 200 })) as unknown as typeof fetch;

    const s = await budget.getBudgetStatusCached({ force: true, fetchImpl });
    expect(s?.providers[0]?.projectedEomUsd).toBeNull();
    expect(s?.providers[0]?.projectedRunoutDate).toBeNull();
    expect(s?.providers[0]?.spendCoverage).toBeNull();
  });
});

describe("usage-budget: checkBudgetAndAlert", () => {
  beforeEach(() => {
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
  });

  it("records a budget_alert notification for an exceeded provider without throwing", async () => {
    const before = listNotificationEvents("local", 100).length;
    await expect(
      budget.checkBudgetAndAlert("local", DEFAULT_POLICY, {
        status: status([{ name: "anthropic", status: "exceeded", spentUsd: 120, monthlyBudgetUsd: 100 }]),
      })
    ).resolves.toBeUndefined();
    const after = listNotificationEvents("local", 100);
    expect(after.length).toBeGreaterThan(before);
    expect(after.some((n) => n.type === "budget_alert")).toBe(true);
  });

  it("suppresses a second alert for the same (user, provider, level) within the cooldown", async () => {
    const provider = `cooldown-provider-${Date.now()}`;
    const st = status([{ name: provider, status: "exceeded", spentUsd: 120, monthlyBudgetUsd: 100 }]);
    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const afterFirst = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;

    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const afterSecond = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;

    expect(afterSecond).toBe(afterFirst); // the second call was suppressed by the cooldown, no new alert
  });

  it("the alert cooldown survives a simulated process restart", async () => {
    const { flushDurableStateNow, resetDurableStateCacheForTests } = await import("../src/lib/durable-state");
    const provider = `restart-provider-${Date.now()}`;
    const st = status([{ name: provider, status: "exceeded", spentUsd: 120, monthlyBudgetUsd: 100 }]);

    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const afterFirst = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    flushDurableStateNow(); // the cooldown's debounced write lands in SQLite

    // Simulate a restart: forget the in-memory durable-state cache (SQLite rows are untouched).
    resetDurableStateCacheForTests();

    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const afterSecond = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    // A fresh process must still honor the cooldown recorded before the "restart" — no duplicate alert.
    expect(afterSecond).toBe(afterFirst);
  });

  it("alerts on a forecasted breach even when lagging MTD status is still ok", async () => {
    const provider = `forecast-provider-${Date.now()}`;
    // MTD spend is comfortably ok (20/100 = 20%), but the projected EOM spend (145) is well past
    // the 100 budget — the forecast-aware alert must still fire.
    const st = status([{
      name: provider,
      status: "ok",
      spentUsd: 20,
      monthlyBudgetUsd: 100,
      projectedEomUsd: 145,
      projectedRunoutDate: "2026-07-22",
    }]);
    const before = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const after = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    expect(after).toBeGreaterThan(before);
  });

  it("does not alert when MTD is ok and there is no forecasted breach", async () => {
    const provider = `no-breach-provider-${Date.now()}`;
    const st = status([{ name: provider, status: "ok", spentUsd: 10, monthlyBudgetUsd: 100, projectedEomUsd: 30 }]);
    const before = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    await budget.checkBudgetAndAlert("local", DEFAULT_POLICY, { status: st });
    const after = listNotificationEvents("local", 200).filter((n) => n.type === "budget_alert").length;
    expect(after).toBe(before);
  });
});

describe("usage-budget: formatBudgetAdvisory", () => {
  it("returns undefined when status is null/undefined", () => {
    expect(budget.formatBudgetAdvisory(null)).toBeUndefined();
    expect(budget.formatBudgetAdvisory(undefined)).toBeUndefined();
  });

  it("returns undefined when every provider is ok/unconfigured (nothing worth mentioning)", () => {
    const s = status([{ name: "openai", status: "ok" }, { name: "anthropic", status: "unconfigured" }]);
    expect(budget.formatBudgetAdvisory(s)).toBeUndefined();
  });

  it("summarizes an exceeded provider with a downgrade/skip suggestion, not a command", () => {
    const s = status([{ name: "openai", status: "exceeded", spentUsd: 150, monthlyBudgetUsd: 100 }]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toBeTruthy();
    expect(line).toContain("openai");
    expect(line).toContain("150.00");
    expect(line).toContain("$100");
    expect(line).toContain("status=exceeded");
    // Advisory language, not a directive — the agent decides.
    expect(line).toMatch(/worth weighing|your call/i);
  });

  it("summarizes a warning provider with a softer watch-it suggestion", () => {
    const s = status([{ name: "anthropic", status: "warning", spentUsd: 85, monthlyBudgetUsd: 100 }]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toBeTruthy();
    expect(line).toContain("anthropic");
    expect(line).toContain("status=warning");
    expect(line).toMatch(/approaching|your call/i);
  });

  it("only mentions notable providers, silently omitting ok/unconfigured ones", () => {
    const s = status([
      { name: "openai", status: "ok" },
      { name: "anthropic", status: "exceeded", spentUsd: 200, monthlyBudgetUsd: 100 },
    ]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toContain("anthropic");
    expect(line).not.toContain("openai");
  });

  it("surfaces a provider that's ok on lagging spend but forecasted to breach, with forecast fields", () => {
    const s = status([{
      name: "openai",
      status: "ok",
      spentUsd: 20,
      monthlyBudgetUsd: 100,
      projectedEomUsd: 145,
      projectedRunoutDate: "2026-07-22",
    }]);
    const line = budget.formatBudgetAdvisory(s);
    expect(line).toBeTruthy();
    expect(line).toContain("openai");
    expect(line).toContain("projected EOM $145.00");
    expect(line).toContain("projected runout 2026-07-22");
    expect(line).toContain("status=ok");
    expect(line).toContain("forecast=exceeded");
  });
});
