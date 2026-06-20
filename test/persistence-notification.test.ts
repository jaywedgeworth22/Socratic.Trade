import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { LLM_OUTPUT_TOKEN_CAPS, LLM_REQUEST_DEFAULTS } from "../src/lib/llm-request";

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => ["SEC 8-K filing for AAPL.\nReported item(s): Item 2.02 Results of Operations and Financial Condition."],
  storeContext: async () => {},
  storeContexts: async () => {}
}));
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-test-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("persistence and notifications", () => {
  it("counts reviewed estimated notional for share-quantity market orders", async () => {
    const { dailyExecutionStats, insertProposal } = await import("../src/lib/db");
    insertProposal({
      id: randomUUID(),
      runId: "run-1",
      accountNumber: "A1",
      proposal: {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        quantity: 0.05,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "test"
      },
      decision: { approved: true, reasons: [] },
      review: { estimatedNotional: 10, alerts: [], raw: {} },
      estimatedNotional: 10,
      status: "paper"
    });

    expect(dailyExecutionStats("A1").notional).toBe(10);
  });

  it("rejects overlapping strategy run locks", async () => {
    const { acquireStrategyLock, releaseStrategyLock } = await import("../src/lib/db");
    expect(acquireStrategyLock()).toBe(true);
    expect(acquireStrategyLock()).toBe(false);
    releaseStrategyLock();
    expect(acquireStrategyLock()).toBe(true);
    releaseStrategyLock();
  });

  it("keeps strategy run locks isolated per user", async () => {
    const { acquireStrategyLock, releaseStrategyLock } = await import("../src/lib/db");
    const userA = `lock-a-${randomUUID()}`;
    const userB = `lock-b-${randomUUID()}`;

    expect(acquireStrategyLock(userA)).toBe(true);
    expect(acquireStrategyLock(userB)).toBe(true);
    expect(acquireStrategyLock(userA)).toBe(false);

    releaseStrategyLock(userA);
    releaseStrategyLock(userB);
  });

  it("maps legacy dryRun policy storage to paperMode without leaking dryRun", async () => {
    const { getPolicy, setSetting } = await import("../src/lib/db");
    setSetting("policy", { ...DEFAULT_POLICY, dryRun: true, paperMode: undefined });

    const policy = getPolicy() as typeof DEFAULT_POLICY & { dryRun?: boolean };

    expect(policy.paperMode).toBe(true);
    expect(policy.dryRun).toBeUndefined();
  });

  it("activates strategy profiles without corrupting user-scoped settings", async () => {
    const userId = `profile-user-${randomUUID()}`;
    const { createStrategyProfile, getStrategyPrompt } = await import("../src/lib/db");

    createStrategyProfile({ name: "Active Test", prompt: "profile prompt", active: true }, userId);

    expect(getStrategyPrompt(userId)).toBe("profile prompt");
  });

  it("keeps connected account credentials server-only and preserves them on metadata edits", async () => {
    const accountId = randomUUID();
    const { getActiveConnectedAccount, listConnectedAccounts, setActiveConnectedAccount, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: accountId,
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST",
      label: "Alpaca Test",
      apiKey: "key-123",
      apiSecret: "secret-456",
      isActive: true
    });

    const listed = listConnectedAccounts().find((account) => account.id === accountId);
    expect(listed?.apiKey).toBeUndefined();
    expect(listed?.apiSecret).toBeUndefined();
    expect(getActiveConnectedAccount()?.apiKey).toBe("key-123");
    expect(getActiveConnectedAccount()?.apiSecret).toBe("secret-456");

    upsertConnectedAccount({
      id: accountId,
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST",
      label: "Renamed Alpaca",
      isActive: true
    });

    expect(getActiveConnectedAccount()?.label).toBe("Renamed Alpaca");
    expect(getActiveConnectedAccount()?.apiKey).toBe("key-123");
    expect(() => setActiveConnectedAccount("missing-account")).toThrow("Connected account not found.");
    expect(getActiveConnectedAccount()?.id).toBe(accountId);
  });

  it("keeps active broker paper account separate from the Test policy toggle", async () => {
    const userId = `execution-mode-user-${randomUUID()}`;
    const accountId = randomUUID();
    const { getActiveConnectedAccount, getPolicy, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { deriveExecutionState } = await import("../src/lib/execution-mode");

    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "APCA-PAPER-TEST",
      label: "Alpaca Paper",
      isActive: true
    });
    setPolicy({ ...DEFAULT_POLICY, paperMode: false, accountNumber: "APCA-PAPER-TEST", activeBroker: "alpaca" }, userId);

    const policy = getPolicy(userId);
    const activeAccount = getActiveConnectedAccount(userId);
    const executionState = deriveExecutionState(policy, activeAccount);

    expect(policy.paperMode).toBe(false);
    expect(policy.activeBroker).toBe("alpaca");
    expect(policy.connectedAccountId).toBe(accountId);
    expect(executionState.mode).toBe("broker/paper");
    expect(executionState.clarification).toContain("Alpaca Paper");
  });

  it("resolves user API keys before env fallback and reports the source", async () => {
    const originalFinnhubKey = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = "env-finnhub";
    try {
      const { deleteUserApiKey, resolveApiKey, resolveApiKeyWithSource, upsertUserApiKey } = await import("../src/lib/db");
      const userId = `key-user-${randomUUID()}`;

      expect(resolveApiKeyWithSource("finnhub", userId)).toMatchObject({ key: "env-finnhub", source: "env", envVar: "FINNHUB_API_KEY" });

      upsertUserApiKey(userId, "FINNHUB_API_KEY", "user-finnhub");
      expect(resolveApiKey("finnhub", userId)).toBe("user-finnhub");
      expect(resolveApiKeyWithSource("finnhub", userId)).toMatchObject({ key: "user-finnhub", source: "user" });

      deleteUserApiKey(userId, "finnhub");
      expect(resolveApiKeyWithSource("finnhub", userId)).toMatchObject({ key: "env-finnhub", source: "env" });
    } finally {
      if (originalFinnhubKey) process.env.FINNHUB_API_KEY = originalFinnhubKey;
      else delete process.env.FINNHUB_API_KEY;
    }
  });

  it("writes one strategy_run audit event from runStrategyOnce", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      if (String(url).includes("nasdaq.com")) {
        return new Response(
          JSON.stringify({
            data: {
              asof: "2026-06-15",
              table: {
                rows: [
                  {
                    symbol: "AAPL",
                    lastsale: "$200",
                    pctchange: "1%",
                    volume: "1000000",
                    marketCap: "3000000000000",
                    sector: "Technology",
                    industry: "Consumer Electronics"
                  }
                ]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const { listAudit, setPolicy, upsertConnectedAccount, setActiveConnectedAccount } = await import("../src/lib/db");
      const { runStrategyOnce } = await import("../src/lib/strategy");
      
      const mockAccountId = randomUUID();
      upsertConnectedAccount({
        id: mockAccountId,
        userId: "local",
        broker: "test",
        environment: "paper",
        accountNumber: "TEST",
        label: "Test Account",
        isActive: true
      });
      setActiveConnectedAccount(mockAccountId);

      setPolicy({
        ...DEFAULT_POLICY,
        systemState: "active",
        paperMode: true,
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        strategyAuthority: "decide"
      });
      const before = listAudit(200).filter((event) => event.kind === "strategy_run").length;
      const result = await runStrategyOnce();
      const after = listAudit(200).filter((event) => event.kind === "strategy_run").length;
      expect(result.status).toBe("completed");
      expect(after).toBe(before + 1);
    } finally {
      if (originalOpenAiKey) process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }, 15_000);

  it("sends retrieved context in user content instead of the stable system prompt", async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai-key";
    const openAiBodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("api.openai.com")) {
        openAiBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [] }) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (href.includes("nasdaq.com")) {
        return new Response(
          JSON.stringify({
            data: {
              asof: "2026-06-15",
              table: {
                rows: [
                  {
                    symbol: "AAPL",
                    lastsale: "$200",
                    pctchange: "1%",
                    volume: "1000000",
                    marketCap: "3000000000000",
                    sector: "Technology",
                    industry: "Consumer Electronics"
                  }
                ]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount } = await import("../src/lib/db");
      const { runStrategyOnce } = await import("../src/lib/strategy");

      const mockAccountId = randomUUID();
      upsertConnectedAccount({
        id: mockAccountId,
        userId: "local",
        broker: "test",
        environment: "paper",
        accountNumber: "TEST",
        label: "Prompt Test Account",
        isActive: true
      });
      setActiveConnectedAccount(mockAccountId);
      setPolicy({
        ...DEFAULT_POLICY,
        systemState: "active",
        paperMode: true,
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        strategyAuthority: "decide"
      });

      await runStrategyOnce();

      expect(openAiBodies).toHaveLength(2);
      expect(openAiBodies.map((body) => body.max_output_tokens)).toEqual([
        LLM_OUTPUT_TOKEN_CAPS.strategyProposal,
        LLM_OUTPUT_TOKEN_CAPS.strategyCritique
      ]);
      expect(openAiBodies.every((body) => body.temperature === LLM_REQUEST_DEFAULTS.deterministicTemperature)).toBe(true);
      expect(openAiBodies.every((body) => body.max_completion_tokens === undefined)).toBe(true);

      const bullBody = openAiBodies[0];
      const systemContent = bullBody.input.find((item: any) => item.role === "system")?.content ?? "";
      const userContent = JSON.parse(bullBody.input.find((item: any) => item.role === "user")?.content ?? "{}");
      expect(systemContent).toContain('Current executionMode is "test/local"');
      expect(systemContent).toContain("not Alpaca Paper");
      expect(userContent.executionMode).toBe("test/local");
      expect(userContent.executionModeClarification).toContain("not Alpaca Paper");
      expect(systemContent).toContain("`retrievedFinancialContext`");
      expect(systemContent).not.toContain("Item 2.02 Results of Operations");
      expect(userContent.retrievedFinancialContext).toContain("Item 2.02 Results of Operations");
      for (const body of openAiBodies) {
        const content = body.input.find((item: any) => item.role === "user")?.content ?? "{}";
        expect(JSON.parse(content).executionMode).toBe("test/local");
      }
    } finally {
      if (originalOpenAiKey) process.env.OPENAI_API_KEY = originalOpenAiKey;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("skips notification delivery when webhook URL is not configured", async () => {
    const { sendNotification } = await import("../src/lib/notifications");
    const event = await sendNotification({ type: "fill", title: "Fill", payload: { id: "1" } }, { policy: DEFAULT_POLICY });
    expect(event.status).toBe("skipped");
    expect(event.error).toContain("Notifications Webhook");
  });

  it("records notification events under the requested user", async () => {
    const { listNotificationEvents } = await import("../src/lib/db");
    const { sendNotification } = await import("../src/lib/notifications");
    const userId = `notify-user-${randomUUID()}`;

    const event = await sendNotification(
      { type: "fill", title: "User Fill", payload: { id: "n1" } },
      { policy: DEFAULT_POLICY, userId }
    );

    const events = listNotificationEvents(userId);
    expect(events[0]?.id).toBe(event.id);
    expect(listNotificationEvents("local").some((item) => item.id === event.id)).toBe(false);
  });

  it("records successful webhook delivery when configured", async () => {
    const { sendNotification } = await import("../src/lib/notifications");
    const event = await sendNotification(
      { type: "fill", title: "Fill", payload: { id: "2" } },
      {
        policy: {
          ...DEFAULT_POLICY,
          notificationSettings: { webhookUrl: "https://example.test/webhook?token=secret", enabledEvents: ["fill"] }
        },
        fetcher: async () => new Response(null, { status: 204 })
      }
    );

    expect(event.status).toBe("sent");
    expect(event.webhookUrl).toBe("https://example.test/webhook");
  });
});
