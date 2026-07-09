/**
 * Model rotation ("__rotate__" testing option) — the sentinel that round-robins the Proposer
 * (green) and/or Reviewer (red) model through every eligible curated model, one per strategy run,
 * so comparative live history accrues across models (proposals stamp `proposedByModel`).
 *
 * Covers: pure round-robin pointer logic (wrap advances the red pointer one extra step so
 * green/red combinations vary), the curated-pool exclusions, the credential-missing skip
 * (rotation never picks a model whose provider key doesn't resolve), pointer persistence via
 * internal settings + pick auditing, the resolveOpenAiModel safety net, and that the sentinel
 * passes /api/policy validation.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-model-rotation-${randomUUID()}.db`)}`;
});

afterEach(() => vi.unstubAllEnvs());

const LLM_ENV = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY"];

function noEnvKeys() {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
  for (const k of LLM_ENV) vi.stubEnv(k, "");
}

describe("advanceRotationPointers (pure round-robin)", () => {
  const pool = ["m0", "m1", "m2"];

  it("cycles the green seat through the pool in order and wraps", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    const picks: string[] = [];
    let counter = 0;
    for (let i = 0; i < 7; i++) {
      const out = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: false, greenCounter: counter, redCounter: 0 });
      picks.push(out.green!.model);
      counter = out.green!.nextPointer;
    }
    expect(picks).toEqual(["m0", "m1", "m2", "m0", "m1", "m2", "m0"]);
  });

  it("advances the red pointer ONE EXTRA step when the green pointer wraps (combinations shift phase)", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    // Green consuming the LAST slot of the cycle = wrap.
    const wrapped = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: true, greenCounter: 2, redCounter: 2 });
    expect(wrapped.green).toMatchObject({ model: "m2", wrapped: true, nextPointer: 3 });
    expect(wrapped.red!.nextPointer).toBe(wrapped.red!.pointer + 2); // extra step
    // Mid-cycle: no extra step.
    const mid = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: true, greenCounter: 0, redCounter: 0 });
    expect(mid.green!.wrapped).toBe(false);
    expect(mid.red!.nextPointer).toBe(mid.red!.pointer + 1);
  });

  it("phase-shifts the green/red pairing across full cycles instead of locking it", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    const pairs = new Set<string>();
    let green = 0;
    let red = 0;
    for (let i = 0; i < pool.length * pool.length; i++) {
      const out = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: true, greenCounter: green, redCounter: red });
      pairs.add(`${out.green!.model}+${out.red!.model}`);
      green = out.green!.nextPointer;
      red = out.red!.nextPointer;
    }
    // Fixed phase would yield exactly |pool| distinct pairs; the wrap-advance must beat that.
    expect(pairs.size).toBe(pool.length * pool.length);
  });

  it("red-only rotation advances by exactly one per run (no green wrap possible)", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    const out = advanceRotationPointers({ pool, rotateGreen: false, rotateRed: true, greenCounter: 2, redCounter: 2 });
    expect(out.green).toBeUndefined();
    expect(out.red!.nextPointer).toBe(out.red!.pointer + 1);
  });

  it("normalizes garbage counters and returns {} on an empty pool", async () => {
    const { advanceRotationPointers } = await import("../src/lib/model-rotation");
    expect(advanceRotationPointers({ pool: [], rotateGreen: true, rotateRed: true, greenCounter: 0, redCounter: 0 })).toEqual({});
    const out = advanceRotationPointers({ pool, rotateGreen: true, rotateRed: false, greenCounter: Number.NaN, redCounter: -7 });
    expect(out.green!.model).toBe("m0");
  });
});

describe("MODEL_ROTATION_POOL (curated catalog minus exclusions)", () => {
  it("excludes the broken/unsuitable models and nothing else from the curated catalog", async () => {
    const { MODEL_ROTATION_POOL } = await import("../src/lib/model-rotation");
    const { CURATED_LLM_MODEL_IDS } = await import("../app/ui/llm-model-catalog");
    const excluded = ["mistral-small-2603", "mistral-medium-3-5", "grok-build-0.1"];
    for (const model of excluded) expect(MODEL_ROTATION_POOL).not.toContain(model);
    // Keep-in-sync check: the pool is exactly the curated catalog minus the exclusions.
    expect(new Set(MODEL_ROTATION_POOL)).toEqual(new Set(CURATED_LLM_MODEL_IDS.filter((id) => !excluded.includes(id))));
    expect(MODEL_ROTATION_POOL).toContain("gpt-5.4-mini");
    expect(MODEL_ROTATION_POOL).toContain("claude-fable-5");
    expect(MODEL_ROTATION_POOL).toContain("grok-4.3");
  });
});

describe("eligibleRotationPool (credential-missing skip)", () => {
  it("keeps only models whose provider credential resolves", async () => {
    noEnvKeys();
    const userId = `rot-cred-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { eligibleRotationPool } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test-openai", "test");
    upsertUserApiKey(userId, "anthropic", "sk-test-anthropic", "test");
    const { pool, skipped } = eligibleRotationPool(userId);
    expect(pool.length).toBeGreaterThan(0);
    for (const model of pool) expect(model).toMatch(/^(gpt-|claude-)/);
    for (const model of skipped) expect(model).not.toMatch(/^(gpt-|claude-)/);
    expect(skipped).toContain("gemini-3.5-flash");
    expect(skipped).toContain("deepseek-v4-pro");
  });
});

describe("resolveModelRotationForRun", () => {
  it("returns {} when neither seat holds the sentinel", async () => {
    noEnvKeys();
    const { resolveModelRotationForRun } = await import("../src/lib/model-rotation");
    const out = resolveModelRotationForRun({
      userId: `rot-none-${randomUUID()}`,
      accountId: "acct-1",
      runId: randomUUID(),
      policy: { llmModel: "gpt-5.4-mini", redTeamLlmModel: "claude-haiku-4-5" }
    });
    expect(out).toEqual({});
  });

  it("rotates the green seat per run with a persisted pointer, never returning the sentinel", async () => {
    noEnvKeys();
    const userId = `rot-green-${randomUUID()}`;
    const accountId = "acct-green";
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    upsertUserApiKey(userId, "anthropic", "sk-test", "test");
    const { pool } = eligibleRotationPool(userId);
    const served: string[] = [];
    for (let i = 0; i < pool.length; i++) {
      const out = resolveModelRotationForRun({
        userId,
        accountId,
        runId: randomUUID(),
        policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }
      });
      expect(out.llmModel).toBeTruthy();
      expect(out.llmModel).not.toBe(LLM_MODEL_ROTATION_SENTINEL);
      expect(out.redTeamLlmModel).toBeUndefined(); // red seat not rotating
      served.push(out.llmModel!);
    }
    // One full cycle serves every eligible model exactly once, in pool order.
    expect(served).toEqual(pool);
  });

  it("rotates both seats independently, audits every pick, and scopes pointers per account", async () => {
    noEnvKeys();
    const userId = `rot-both-${randomUUID()}`;
    const { upsertUserApiKey, getDb } = await import("../src/lib/db");
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const runId = randomUUID();
    const out = resolveModelRotationForRun({
      userId,
      accountId: "acct-A",
      runId,
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, redTeamLlmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    expect(out.llmModel).toMatch(/^gpt-/);
    expect(out.redTeamLlmModel).toMatch(/^gpt-/);
    const audits = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'model_rotation_pick' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    const parsed = audits.map((row) => JSON.parse(row.payload) as { runId: string; seat: string; model: string; pointer: number });
    expect(parsed.filter((p) => p.runId === runId).map((p) => p.seat).sort()).toEqual(["green", "red"]);
    for (const pick of parsed) {
      expect(typeof pick.pointer).toBe("number");
      expect(pick.model).not.toBe(LLM_MODEL_ROTATION_SENTINEL);
    }
    // A different account starts at its own pointer (slot 0), independent of acct-A's advance.
    const other = resolveModelRotationForRun({
      userId,
      accountId: "acct-B",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    expect(other.llmModel).toBe(out.llmModel); // acct-A consumed slot 0; acct-B starts fresh at slot 0
  });

  it("fails the rotating seats closed (empty override models, not the sentinel) when no credential resolves at all", async () => {
    noEnvKeys();
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    const out = resolveModelRotationForRun({
      userId: `rot-nokeys-${randomUUID()}`,
      accountId: "acct-1",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, redTeamLlmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    // No-defaults (owner 2026-07-07): an empty pool resolves the rotating seats to "" — the normal
    // unconfigured/fail-closed state — never the raw "__rotate__" sentinel nor a removed default.
    expect(out).toEqual({ llmModel: "", redTeamLlmModel: "" });
  });
});

describe("sentinel handling at the edges", () => {
  it("resolveOpenAiModel treats the sentinel as unset (safety net for non-run consumers)", async () => {
    vi.stubEnv("OPENAI_MODEL", "");
    const { resolveOpenAiModel, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/llm-request");
    // No-defaults: the sentinel (like any unset model) resolves to "" — fail closed, never a default.
    expect(resolveOpenAiModel({ llmModel: LLM_MODEL_ROTATION_SENTINEL })).toBe("");
    expect(resolveOpenAiModel({ llmModel: "gpt-5.5" })).toBe("gpt-5.5");
  });

  it("PUT /api/policy accepts and persists the sentinel for both seats", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const response = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmModel: "__rotate__", redTeamLlmModel: "__rotate__" })
      })
    );
    expect(response.status).toBe(200);
    const saved = getPolicy(DEFAULT_REQUEST_USER_ID);
    expect(saved.llmModel).toBe("__rotate__");
    expect(saved.redTeamLlmModel).toBe("__rotate__");
  });
});
