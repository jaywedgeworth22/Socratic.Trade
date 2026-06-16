import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

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

  it("maps legacy dryRun policy storage to paperMode without leaking dryRun", async () => {
    const { getPolicy, setSetting } = await import("../src/lib/db");
    setSetting("policy", { ...DEFAULT_POLICY, dryRun: true, paperMode: undefined });

    const policy = getPolicy() as typeof DEFAULT_POLICY & { dryRun?: boolean };

    expect(policy.paperMode).toBe(true);
    expect(policy.dryRun).toBeUndefined();
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
      const { listAudit, setPolicy } = await import("../src/lib/db");
      const { runStrategyOnce } = await import("../src/lib/strategy");
      setPolicy({
        ...DEFAULT_POLICY,
        enabled: true,
        paperMode: true,
        accountNumber: "RH-MOCK-AGENT",
        allowlist: ["AAPL"],
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
  });

  it("skips notification delivery when webhook URL is not configured", async () => {
    const { sendNotification } = await import("../src/lib/notifications");
    const event = await sendNotification({ type: "fill", title: "Fill", payload: { id: "1" } }, { policy: DEFAULT_POLICY });
    expect(event.status).toBe("skipped");
    expect(event.error).toContain("Notifications Webhook");
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
