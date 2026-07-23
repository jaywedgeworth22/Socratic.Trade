/**
 * POST /api/strategy/run — async run-once (FIX 1, owner-reported Cloudflare 524 bug).
 *
 * Production sits behind Cloudflare (~100s edge timeout); a real LLM-driven run can take several
 * minutes, so awaiting runStrategyOnce() to completion in the route always 524s on a slow run
 * while the origin keeps running — the owner saw the raw Cloudflare 524 HTML page rendered as
 * "the run failed" when the run had actually kept going and finished minutes later.
 *
 * The route now races runStrategyOnce() (the SAME execution path the scheduler uses) against a
 * bounded window (RUN_ONCE_SYNC_WINDOW_MS, default 8s in production) instead of always awaiting
 * it fully:
 *   - A run that settles inside the window (fast pre-flight blocks: already-in-progress lock,
 *     halted, no account, market-closed, ...) is returned EXACTLY as before — same status code,
 *     same summary string.
 *   - A run that outlives the window gets a 202 { status: "started" } response instead; the run
 *     keeps executing in the background (see trackDetached() in the route).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/strategy", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/strategy")>();
  return { ...actual, runStrategyOnce: vi.fn() };
});

import { runStrategyOnce } from "@/lib/strategy";
import { getPolicy, setPolicy } from "@/lib/db";
import { DEV_USER_ID } from "@/lib/auth/identity";

const LLM_ENV = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY"];

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-run-once-async-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(runStrategyOnce).mockReset();
});

// The route's pre-flight now runs TWO synchronous gates before the async race (owner directive
// 2026-07-07, no model defaults): a resolvable KEY (LLM_REQUIRED_STRATEGY_MESSAGE 412) AND a
// non-blank Green MODEL (LLM_MODEL_REQUIRED_STRATEGY_MESSAGE 412). To exercise the async-race
// behavior below (202/400/200), the request's user (DEV_USER_ID for an unauthenticated request)
// must have a real Green model persisted, otherwise the second gate 412s first.
function stubLlmKeyAvailable(): void {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "on");
  vi.stubEnv("OPENROUTER_API_KEY", "test-operator-key");
  setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "gpt-5.4-mini" }, DEV_USER_ID);
}

function stubNoLlmKey(): void {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
  for (const k of LLM_ENV) vi.stubEnv(k, "");
}

async function callRoute(body: unknown = { manual: true }): Promise<Response> {
  const { getDb } = await import("../src/lib/db");
  getDb();
  const { POST } = await import("../app/api/strategy/run/route");
  return POST(new Request("http://localhost/api/strategy/run", { method: "POST", body: JSON.stringify(body) }));
}

describe("POST /api/strategy/run — async run-once", () => {
  it("returns a 'started' marker fast and does NOT wait for the run executor to resolve", async () => {
    stubLlmKeyAvailable();
    vi.stubEnv("RUN_ONCE_SYNC_WINDOW_MS", "20");

    let resolveRun!: (value: unknown) => void;
    const pendingRun = new Promise((resolve) => {
      resolveRun = resolve;
    });
    vi.mocked(runStrategyOnce).mockReturnValue(pendingRun as never);

    const start = Date.now();
    const res = await callRoute();
    const elapsed = Date.now() - start;

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; summary: string };
    expect(body.status).toBe("started");
    expect(typeof body.summary).toBe("string");
    expect(body.summary.length).toBeGreaterThan(0);
    // The mocked executor is STILL pending at this point (we haven't called resolveRun yet) — the
    // route returning already proves it didn't await the full run.
    expect(elapsed).toBeLessThan(2_000);

    // Settle the still-pending executor so it doesn't linger as an unresolved/unhandled promise
    // past the test (the route's trackDetached() attaches a .catch, but nothing awaits resolution).
    resolveRun({ runId: "bg-1", status: "completed", summary: "done", proposals: [] });
    await new Promise((r) => setTimeout(r, 10));
  });

  it("still returns a REAL fast pre-flight block exactly as before (run already in progress)", async () => {
    stubLlmKeyAvailable();
    // Default (8s) sync window; the mocked executor resolves near-instantly, well inside it —
    // this is the acquireStrategyLock() fast-fail path inside runStrategyOnce.
    vi.mocked(runStrategyOnce).mockResolvedValue({
      runId: "",
      status: "failed",
      summary: "A strategy run is already in progress.",
      proposals: []
    } as never);

    const res = await callRoute();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { status: string; summary: string };
    expect(body.status).toBe("failed");
    expect(body.summary).toBe("A strategy run is already in progress.");
  });

  it("still returns a completed result inline when the run genuinely finishes fast", async () => {
    stubLlmKeyAvailable();
    vi.mocked(runStrategyOnce).mockResolvedValue({
      runId: "run-1",
      status: "completed",
      summary: "Market closed (holiday or weekend). Skipping strategy run.",
      proposals: []
    } as never);

    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; status: string };
    expect(body).toMatchObject({ runId: "run-1", status: "completed" });
  });

  it("keeps the 412 LLM-gate pre-check synchronous and never launches the run executor", async () => {
    stubNoLlmKey();
    setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "gpt-5.4-mini" }, DEV_USER_ID);
    const res = await callRoute();
    expect(res.status).toBe(412);
    expect(runStrategyOnce).not.toHaveBeenCalled();
  });

  it("still 412s an explicitly BLANK Green model with the model-choice message (key present)", async () => {
    stubLlmKeyAvailable();
    setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "" }, DEV_USER_ID);
    const res = await callRoute();
    expect(res.status).toBe(412);
    const body = (await res.json()) as { summary: string };
    const { LLM_MODEL_REQUIRED_STRATEGY_MESSAGE } = await import("../src/lib/llm-required");
    expect(body.summary).toBe(LLM_MODEL_REQUIRED_STRATEGY_MESSAGE);
    expect(runStrategyOnce).not.toHaveBeenCalled();
  });

  // Rotation precheck (owner-reported): the persisted "__rotate__" sentinel deliberately resolves
  // as UNSET in resolveOpenAiModel (llm-request.ts safety net), so the old model gate 412'd every
  // manual Run-once under rotation even though runStrategyOnce resolves the sentinel to a concrete
  // model at the top of the run (scheduled runs worked). The route now gates a rotating Green on
  // the credential-filtered rotation pool instead.
  it("lets a rotating Green through when the eligible rotation pool is non-empty (no 412)", async () => {
    stubLlmKeyAvailable(); // operator OpenAI key → gpt-* models are pool-eligible
    setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "__rotate__" }, DEV_USER_ID);
    vi.mocked(runStrategyOnce).mockResolvedValue({
      runId: "run-rotate",
      status: "completed",
      summary: "ok",
      proposals: []
    } as never);
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(runStrategyOnce).toHaveBeenCalledTimes(1);
  });

  it("412s a rotating Green with the actionable ROTATION message when NO credential resolves (empty pool)", async () => {
    stubNoLlmKey();
    setPolicy({ ...getPolicy(DEV_USER_ID), llmModel: "__rotate__" }, DEV_USER_ID);
    const res = await callRoute();
    expect(res.status).toBe(412);
    const body = (await res.json()) as { summary: string };
    const { LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE } = await import("../src/lib/llm-required");
    expect(body.summary).toBe(LLM_ROTATION_EMPTY_POOL_STRATEGY_MESSAGE);
    expect(runStrategyOnce).not.toHaveBeenCalled();
  });

  it("does NOT gate on a rotating RED seat (blank/rotating red routes per-opening to human, not a 412)", async () => {
    stubLlmKeyAvailable(); // Green = concrete gpt-5.4-mini via stub
    setPolicy({ ...getPolicy(DEV_USER_ID), redTeamLlmModel: "__rotate__" }, DEV_USER_ID);
    vi.mocked(runStrategyOnce).mockResolvedValue({
      runId: "run-red-rotate",
      status: "completed",
      summary: "ok",
      proposals: []
    } as never);
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(runStrategyOnce).toHaveBeenCalledTimes(1);
  });
});
