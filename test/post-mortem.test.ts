import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS } from "../src/lib/llm-request";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-post-mortem-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_URL;
});

describe("generateReflectionSummary", () => {
  it("bounds the reflection request and sends broker paper execution context", async () => {
    const userId = `post-mortem-${randomUUID()}`;
    const accountNumber = "APCA-PAPER-REFLECT";
    const accountId = randomUUID();
    const { getUserSetting, insertFillEvent, setActiveConnectedAccount, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { generateReflectionSummary } = await import("../src/lib/post-mortem");

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
    setPolicy({ ...DEFAULT_POLICY, accountNumber, paperMode: false, activeBroker: "alpaca" }, userId);
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

    let requestBody: any;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ output_text: "Keep broker paper results separate from local simulation." }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    await generateReflectionSummary(accountNumber, userId);

    expect(requestBody.max_output_tokens).toBe(LLM_OUTPUT_TOKEN_CAPS.postMortemReflection);
    expect(requestBody.temperature).toBe(LLM_REQUEST_DEFAULTS.deterministicTemperature);
    expect(requestBody.max_completion_tokens).toBeUndefined();
    const context = JSON.parse(requestBody.input.find((item: any) => item.role === "user")?.content ?? "{}");
    expect(context.executionMode).toBe("broker/paper");
    expect(context.executionModeClarification).toContain("Alpaca Paper");
    expect(context.recentTrades[0]?.symbol).toBe("AAPL");
    expect(getUserSetting(userId, "reflection_summary", "")).toContain("broker paper");
  });
});
