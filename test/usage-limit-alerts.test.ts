import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-usage-limit-alerts-${randomUUID()}.db`)}`;
});

describe("usage limit alerts", () => {
  it("records a budget_alert and emails the operator fallback when a provider cap is hit", async () => {
    const userId = `limit-alert-${randomUUID()}`;
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubEnv("RESEND_API_KEY", "rk_test");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "alerts@example.test");
    vi.stubEnv("USAGE_LIMIT_ALERT_EMAIL", "owner@example.test");
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response("ok", { status: 200 });
      }) as typeof fetch
    );

    const { alertUsageLimitHit } = await import("../src/lib/usage-limit-alerts");
    const { listNotificationEvents } = await import("../src/lib/db");

    await alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: "exceeded",
      used: 50_000,
      limit: 50_000,
      attempted: 62_000,
      skipped: 3,
      unit: "estimated WUs",
      recommendation: "Inspect chunking and deduping before raising the cap."
    });

    const events = listNotificationEvents(userId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "budget_alert",
      title: "Usage limit hit: Pinecone Write Unit daily fuse",
      status: "skipped"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.body).toMatchObject({
      from: "alerts@example.test",
      to: ["owner@example.test"],
      subject: "Usage limit hit: Pinecone Write Unit daily fuse"
    });
    expect(String((calls[0]?.body as { text?: string }).text)).toContain("Inspect chunking and deduping");

    await alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: "exceeded"
    });
    expect(listNotificationEvents(userId, 10)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
