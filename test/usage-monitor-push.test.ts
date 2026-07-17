import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

// Isolated temp SQLite (logApiHealth writes to the DB on flush).
const tmpDir = path.join(os.tmpdir(), `trading-test-usage-push-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

const push = await import("../src/lib/usage-monitor-push");
const { recordLlmUsage } = await import("../src/lib/llm-usage");
const { recordRagUsage } = await import("../src/lib/rag-metering");
const { getDb } = await import("../src/lib/db");

const BASE = "https://usage.example.test";
const TOKEN = "test-token";

interface CapturedRequest {
  url: string;
  auth: string | null;
  rawBody: string;
  body: { events: Array<Record<string, unknown>> };
}

function makeFetchStub(captured: CapturedRequest[]) {
  return (async (url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const rawBody = String(init?.body ?? "{}");
    captured.push({
      url: String(url),
      auth: headers?.authorization ?? headers?.Authorization ?? null,
      rawBody,
      body: JSON.parse(rawBody),
    });
    return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 202 });
  }) as unknown as typeof fetch;
}

function expectedTelemetryKey(kind: string, sourceId: string): string {
  const digest = createHash("sha256")
    .update(`${kind}\0${sourceId.trim()}`)
    .digest("hex");
  return `socratic-trade:${kind}:${digest}`;
}

describe("usage-monitor-push", () => {
  beforeEach(() => {
    push.__resetUsageMonitorState();
    process.env.USAGE_MONITOR_BASE_URL = BASE;
    process.env.USAGE_INGEST_TOKEN = TOKEN;
    process.env.USAGE_MONITOR_ENV = "test";
  });
  afterEach(() => {
    push.__resetUsageMonitorState();
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_MONITOR_ENV;
  });

  it("is a no-op when unconfigured (no network calls)", async () => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushLlmUsage({ provider: "openrouter", userId: "local", keySource: "operator", totalTokens: 100, costUsd: 0.01 });
    push.recordProviderCall("finnhub", { ok: true });
    await push.flushUsageMonitor();
    expect(captured).toHaveLength(0);
  });

  it("pushes an LLM cost event as a schema-valid batch with bearer auth", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushLlmUsage({
      sourceEventId: "llm-row-123",
      provider: "anthropic",
      model: "claude-opus-4-8",
      context: "strategy",
      userId: "local",
      keySource: "operator",
      keyRef: "abcd",
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
      costUsd: 0.03,
    });
    await push.flushUsageMonitor();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(`${BASE}/api/ingest/usage`);
    expect(captured[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const events = captured[0]!.body.events;
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.sourceApp).toBe("socratic-trade");
    expect(e.project).toBe("socratic-trade");
    expect(e.environment).toBe("test");
    expect(e.provider).toBe("anthropic");
    expect(e.service).toBe("llm");
    expect(e.metricType).toBe("cost");
    expect(e.unit).toBe("token");
    expect(e.quantity).toBe(1000);
    expect(e.costUsd).toBe(0.03);
    expect(e.requests).toBe(1);
    expect(e.idempotencyKey).toBe(expectedTelemetryKey("llm", "llm-row-123"));
    expect(typeof e.occurredAt).toBe("string");
    expect((e.metadata as Record<string, unknown>).model).toBe("claude-opus-4-8");
  });

  it("pushes a RAG event and aggregates market-data call-volume in one flush", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushRagUsage({ sourceEventId: "rag-row-123", provider: "voyage", operation: "embed", model: "voyage-finance-2", userId: "local", tokensIn: 120, costUsd: 0.00001 });
    push.recordProviderCall("finnhub", { ok: true });
    push.recordProviderCall("finnhub", { ok: true });
    push.recordProviderCall("finnhub", { ok: false });
    await push.flushUsageMonitor();

    expect(captured).toHaveLength(1);
    const events = captured[0]!.body.events;
    expect(events.every((event) => event.project === "socratic-trade")).toBe(true);
    const rag = events.find((e) => e.service === "rag");
    expect(rag).toBeDefined();
    expect(rag!.provider).toBe("voyage");
    expect(rag!.unit).toBe("token");
    expect(rag!.idempotencyKey).toBe(expectedTelemetryKey("rag", "rag-row-123"));

    const vol = events.find((e) => e.provider === "finnhub");
    expect(vol).toBeDefined();
    expect(vol!.metricType).toBe("usage");
    expect(vol!.unit).toBe("request");
    expect(vol!.requests).toBe(3);
    expect(vol!.idempotencyKey).toMatch(
      /^socratic-trade:provider-call-volume:/
    );
    expect((vol!.metadata as Record<string, unknown>).successes).toBe(2);
    expect((vol!.metadata as Record<string, unknown>).failures).toBe(1);
  });

  it("tags Pinecone RAG volume as credits and scopes call-volume by key lane", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushRagUsage({ provider: "pinecone", operation: "query", userId: "local", tokensIn: 7, tokensOut: 5 });
    push.recordProviderCall("finnhub", { ok: true, keySource: "user", userId: "u_abc" });
    push.recordProviderCall("finnhub", { ok: true, keySource: "operator" });
    await push.flushUsageMonitor();

    const events = captured[0]!.body.events;
    const pine = events.find((e) => e.provider === "pinecone");
    expect(pine!.unit).toBe("credit");
    expect(pine!.quantity).toBe(7);
    expect((pine!.metadata as Record<string, unknown>).recordCount).toBe(5);

    // Two different credential lanes → two separate finnhub events, not one merged count.
    const finnhub = events.filter((e) => e.provider === "finnhub");
    expect(finnhub).toHaveLength(2);
    const laneKeys = finnhub.map((event) => event.idempotencyKey);
    expect(laneKeys.every((key) => typeof key === "string")).toBe(true);
    expect(new Set(laneKeys).size).toBe(2);
    const userLane = finnhub.find((e) => (e.metadata as Record<string, unknown>).keySource === "user");
    expect(userLane).toBeDefined();
    expect((userLane!.metadata as Record<string, unknown>).userId).toBe("u_abc");
  });

  it("retries a failed batch with the exact original payload while ledger writes stay non-blocking", async () => {
    const attempts: CapturedRequest[] = [];
    let attempt = 0;
    push.__setUsageMonitorFetch((async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const rawBody = String(init?.body ?? "{}");
      attempts.push({
        url: String(url),
        auth: headers?.authorization ?? headers?.Authorization ?? null,
        rawBody,
        body: JSON.parse(rawBody),
      });
      attempt += 1;
      if (attempt === 1) throw new Error("connection closed after request write");
      return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 202 });
    }) as unknown as typeof fetch);
    expect(() =>
      recordLlmUsage({ provider: "openrouter", model: "gpt-4o-mini", context: "chat", userId: "local", keySource: "operator", promptTokens: 10, completionTokens: 5 })
    ).not.toThrow();
    await expect(push.flushUsageMonitor()).resolves.toBeUndefined();
    expect(attempts).toHaveLength(1);

    // Manual flush stands in for the scheduled retry and must not regenerate
    // either occurredAt or the explicit delivery identity.
    await expect(push.flushUsageMonitor()).resolves.toBeUndefined();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.rawBody).toBe(attempts[0]!.rawBody);
    expect(attempts[1]).toEqual(attempts[0]);

    const { getLlmUsageSummary } = await import("../src/lib/llm-usage");
    expect(getLlmUsageSummary().length).toBeGreaterThan(0);
  });

  it("uses one durable LLM ledger identity and timestamp for persistence and delivery", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    recordLlmUsage({
      provider: "openrouter",
      model: "gpt-4o-mini",
      context: "telemetry-id-test",
      userId: "local",
      keySource: "operator",
      promptTokens: 10,
      completionTokens: 5,
    });
    await push.flushUsageMonitor();

    const row = getDb()
      .prepare(
        "SELECT id, created_at FROM llm_usage WHERE context = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get("telemetry-id-test") as { id: string; created_at: string };
    const event = captured[0]!.body.events[0]!;
    expect(event.idempotencyKey).toBe(expectedTelemetryKey("llm", row.id));
    expect(event.occurredAt).toBe(row.created_at);
  });

  it("uses one durable RAG ledger identity and timestamp for persistence and delivery", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    recordRagUsage({
      provider: "voyage",
      model: "voyage-finance-2",
      operation: "embed",
      userId: "telemetry-rag-user",
      tokensIn: 25,
      batchCount: 1,
    });
    await push.flushUsageMonitor();

    const row = getDb()
      .prepare(
        "SELECT id, created_at FROM rag_usage WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get("telemetry-rag-user") as { id: string; created_at: string };
    const event = captured[0]!.body.events[0]!;
    expect(event.idempotencyKey).toBe(expectedTelemetryKey("rag", row.id));
    expect(event.occurredAt).toBe(row.created_at);
  });

  it("replays the same source identity with a stable key and occurredAt", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    const entry = {
      sourceEventId: "llm-ledger-replay",
      occurredAt: "2026-07-11T18:00:00.000Z",
      provider: "openrouter",
      model: "gpt-5-mini",
      userId: "local",
      keySource: "operator",
      totalTokens: 42,
      costUsd: 0.001,
    } as const;

    push.pushLlmUsage(entry);
    push.pushLlmUsage(entry);
    await push.flushUsageMonitor();

    const events = captured[0]!.body.events;
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(events[0]);
    expect(events[0]!.idempotencyKey).toBe(
      expectedTelemetryKey("llm", entry.sourceEventId)
    );
    expect(events[0]!.occurredAt).toBe(entry.occurredAt);
  });

  it("bounds oversized source IDs and gives blank IDs independent valid identities", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    const oversized = `ledger-${"x".repeat(10_000)}`;
    const base = {
      occurredAt: "2026-07-11T18:30:00.000Z",
      provider: "openrouter",
      userId: "local",
      keySource: "operator",
      totalTokens: 1,
    } as const;

    push.pushLlmUsage({ ...base, sourceEventId: oversized });
    push.pushLlmUsage({ ...base, sourceEventId: "" });
    push.pushLlmUsage({ ...base, sourceEventId: "" });
    await push.flushUsageMonitor();

    const keys = captured[0]!.body.events.map((event) => String(event.idempotencyKey));
    expect(keys[0]).toBe(expectedTelemetryKey("llm", oversized));
    expect(keys.every((key) => key.length <= 200)).toBe(true);
    expect(keys.every((key) => /^socratic-trade:llm:[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(keys[1]).not.toBe(keys[2]);
  });

  it("cancels a stale HMR timer and preserves its buffered event for the current module", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushLlmUsage({
      sourceEventId: "hmr-buffered-event",
      occurredAt: "2026-07-11T19:00:00.000Z",
      provider: "openrouter",
      userId: "local",
      keySource: "operator",
      totalTokens: 5,
    });

    const shared = (globalThis as unknown as {
      __usageMonitorPush?: {
        version: number;
        flushTimer: ReturnType<typeof setTimeout> | null;
      };
    }).__usageMonitorPush;
    expect(shared).toBeDefined();
    if (shared?.flushTimer) clearTimeout(shared.flushTimer);
    const staleTimer = setTimeout(() => undefined, 60_000);
    staleTimer.unref?.();
    shared!.version = 1;
    shared!.flushTimer = staleTimer;
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    vi.resetModules();
    const reloaded = await import("../src/lib/usage-monitor-push");
    expect(clearSpy).toHaveBeenCalledWith(staleTimer);
    clearSpy.mockRestore();

    await reloaded.flushUsageMonitor();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.events[0]!.idempotencyKey).toBe(
      expectedTelemetryKey("llm", "hmr-buffered-event")
    );
  });

  it("allocates a new explicit key for each aggregate window", async () => {
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));

    push.recordProviderCall("finnhub", { ok: true, keySource: "operator" });
    await push.flushUsageMonitor();
    push.recordProviderCall("finnhub", { ok: true, keySource: "operator" });
    await push.flushUsageMonitor();

    expect(captured).toHaveLength(2);
    const firstKey = captured[0]!.body.events[0]!.idempotencyKey;
    const secondKey = captured[1]!.body.events[0]!.idempotencyKey;
    expect(firstKey).toMatch(/^socratic-trade:provider-call-volume:/);
    expect(secondKey).toMatch(/^socratic-trade:provider-call-volume:/);
    expect(secondKey).not.toBe(firstKey);
  });
});
