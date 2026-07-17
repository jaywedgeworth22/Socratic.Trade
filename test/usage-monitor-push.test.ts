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
    delete process.env.USAGE_MONITOR_BREAKER_THRESHOLD;
    delete process.env.USAGE_MONITOR_BREAKER_BASE_MS;
    delete process.env.USAGE_MONITOR_BREAKER_MAX_MS;
    delete process.env.USAGE_MONITOR_QUEUE_MAX_EVENTS;
    delete process.env.USAGE_MONITOR_QUEUE_TTL_MS;
    delete process.env.USAGE_MONITOR_CALLVOLUME_MAX_KEYS;
    delete process.env.USAGE_MONITOR_PUSH_TIMEOUT_MS;
  });

  it("is a no-op when unconfigured (no network calls)", async () => {
    delete process.env.USAGE_MONITOR_BASE_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(makeFetchStub(captured));
    push.pushLlmUsage({ provider: "openai", userId: "local", keySource: "operator", totalTokens: 100, costUsd: 0.01 });
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
      recordLlmUsage({ provider: "openai", model: "gpt-4o-mini", context: "chat", userId: "local", keySource: "operator", promptTokens: 10, completionTokens: 5 })
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
      provider: "openai",
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
      provider: "openai",
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
      provider: "openai",
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
      provider: "openai",
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

  describe("circuit breaker (dead-receiver protection)", () => {
    it("opens after N consecutive failures and fully suppresses further attempts (no network call)", async () => {
      process.env.USAGE_MONITOR_BREAKER_THRESHOLD = "2";
      process.env.USAGE_MONITOR_BREAKER_BASE_MS = "60000";
      process.env.USAGE_MONITOR_BREAKER_MAX_MS = "60000";
      let attempts = 0;
      push.__setUsageMonitorFetch((async () => {
        attempts += 1;
        throw new Error("connection refused");
      }) as unknown as typeof fetch);

      push.pushLlmUsage({ sourceEventId: "breaker-1", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
      await push.flushUsageMonitor(); // failure #1 — below threshold, breaker stays closed
      expect(attempts).toBe(1);
      expect(push.__usageMonitorDebugState().breaker.openUntil).toBe(0);

      await push.flushUsageMonitor(); // failure #2 — trips the breaker
      expect(attempts).toBe(2);
      expect(push.__usageMonitorDebugState().breaker.openUntil).toBeGreaterThan(Date.now());

      // A third flush must not touch the network at all while the circuit is open.
      push.pushLlmUsage({ sourceEventId: "breaker-2", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
      await push.flushUsageMonitor();
      expect(attempts).toBe(2);
    });

    it("recovers via a single half-open probe once the backoff window elapses", async () => {
      process.env.USAGE_MONITOR_BREAKER_THRESHOLD = "1";
      process.env.USAGE_MONITOR_BREAKER_BASE_MS = "40";
      process.env.USAGE_MONITOR_BREAKER_MAX_MS = "40";
      let attempts = 0;
      push.__setUsageMonitorFetch((async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("connection refused");
        return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 202 });
      }) as unknown as typeof fetch);

      push.pushLlmUsage({ sourceEventId: "probe-1", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
      await push.flushUsageMonitor(); // trips the breaker immediately (threshold = 1)
      expect(attempts).toBe(1);
      expect(push.__usageMonitorDebugState().breaker.openUntil).toBeGreaterThan(Date.now());

      // Still inside the open window: suppressed, no second network call.
      await push.flushUsageMonitor();
      expect(attempts).toBe(1);

      // Wait out the (short, test-only) backoff window, then the next attempt is the half-open probe.
      await new Promise((resolve) => setTimeout(resolve, 70));
      await push.flushUsageMonitor();
      expect(attempts).toBe(2);
      const debug = push.__usageMonitorDebugState();
      expect(debug.breaker.openUntil).toBe(0);
      expect(debug.breaker.consecutiveFailures).toBe(0);
    });

    it("never blocks the user-facing ledger call sites, even while the circuit is open", async () => {
      process.env.USAGE_MONITOR_BREAKER_THRESHOLD = "1";
      push.__setUsageMonitorFetch((async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch);
      push.pushLlmUsage({ sourceEventId: "block-check-1", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
      await push.flushUsageMonitor(); // trips the breaker
      expect(push.__usageMonitorDebugState().breaker.openUntil).toBeGreaterThan(Date.now());

      // Swap in a fetch that would hang forever if it were ever called — proves the breaker gates
      // BEFORE any network I/O, and proves the sync call sites never await it either way.
      let fetchCalled = false;
      push.__setUsageMonitorFetch((() => {
        fetchCalled = true;
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch);

      const start = Date.now();
      expect(() =>
        push.pushLlmUsage({ provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 })
      ).not.toThrow();
      expect(() => push.recordProviderCall("finnhub", { ok: true })).not.toThrow();
      expect(Date.now() - start).toBeLessThan(20);

      await push.flushUsageMonitor();
      expect(fetchCalled).toBe(false);
    });
  });

  describe("bounded in-memory buffer", () => {
    it("caps total buffered events so a sustained outage can't grow memory without limit", () => {
      process.env.USAGE_MONITOR_QUEUE_MAX_EVENTS = "5";
      for (let i = 0; i < 20; i += 1) {
        push.pushLlmUsage({
          sourceEventId: `bulk-${i}`,
          provider: "openai",
          userId: "local",
          keySource: "operator",
          totalTokens: 1,
        });
      }
      expect(push.__usageMonitorDebugState().queueDepth).toBeLessThanOrEqual(5);
    });

    it("TTL-expires events that have sat unsent past the configured window", async () => {
      process.env.USAGE_MONITOR_QUEUE_TTL_MS = "50";
      push.pushLlmUsage({ sourceEventId: "ttl-old", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
      expect(push.__usageMonitorDebugState().queueDepth).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 90));
      push.pushLlmUsage({ sourceEventId: "ttl-fresh", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
      expect(push.__usageMonitorDebugState().queueDepth).toBe(1);
    });

    it("TTLs by buffer residency time, not by the event's own business occurredAt", async () => {
      const captured: CapturedRequest[] = [];
      push.__setUsageMonitorFetch(makeFetchStub(captured));
      process.env.USAGE_MONITOR_QUEUE_TTL_MS = "1000";
      push.pushLlmUsage({
        sourceEventId: "ancient-occurred-at",
        occurredAt: "2020-01-01T00:00:00.000Z",
        provider: "openai",
        userId: "local",
        keySource: "operator",
        totalTokens: 1,
      });
      await push.flushUsageMonitor();
      expect(captured).toHaveLength(1);
      expect(captured[0]!.body.events[0]!.occurredAt).toBe("2020-01-01T00:00:00.000Z");
    });

    it("drops a TTL-expired event at flush entry even when no new telemetry arrives", async () => {
      const captured: CapturedRequest[] = [];
      push.__setUsageMonitorFetch(makeFetchStub(captured));
      process.env.USAGE_MONITOR_QUEUE_TTL_MS = "50";
      push.pushLlmUsage({ sourceEventId: "flush-ttl", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
      expect(push.__usageMonitorDebugState().queueDepth).toBe(1);

      // No further pushes — the only trim opportunity is flush entry itself.
      await new Promise((resolve) => setTimeout(resolve, 90));
      await push.flushUsageMonitor();
      expect(captured).toHaveLength(0);
      expect(push.__usageMonitorDebugState().queueDepth).toBe(0);
    });

    it("caps the callVolume aggregation map by distinct lane count", () => {
      process.env.USAGE_MONITOR_CALLVOLUME_MAX_KEYS = "3";
      // 10 distinct user lanes for the same provider → 10 distinct callVolume keys without a cap.
      for (let i = 0; i < 10; i += 1) {
        push.recordProviderCall("finnhub", { ok: true, keySource: "user", userId: `u_${i}` });
      }
      expect(push.__usageMonitorDebugState().callVolumeKeys).toBeLessThanOrEqual(3);
    });
  });

  describe("live-push per-attempt timeout (half-up receiver)", () => {
    it("times out a hung send, records a failure, and feeds the breaker", async () => {
      process.env.USAGE_MONITOR_PUSH_TIMEOUT_MS = "40";
      process.env.USAGE_MONITOR_BREAKER_THRESHOLD = "1";
      let abortObserved = false;
      // A monitor that accepts the connection but never responds — resolves only if aborted.
      push.__setUsageMonitorFetch(((_url: unknown, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              abortObserved = true;
              reject(new DOMException("The operation was aborted", "AbortError"));
            });
          }
        });
      }) as unknown as typeof fetch);

      push.pushLlmUsage({ sourceEventId: "hung-1", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
      const started = Date.now();
      await push.flushUsageMonitor();
      // Bounded: the flush returned near the timeout, not hung indefinitely.
      expect(Date.now() - started).toBeLessThan(2000);
      expect(abortObserved).toBe(true);
      const debug = push.__usageMonitorDebugState();
      expect(debug.breaker.consecutiveFailures).toBe(1);
      expect(debug.breaker.openUntil).toBeGreaterThan(Date.now());
    });
  });

  describe("HMR queue shape migration", () => {
    it("coerces a retained pre-v4 raw-event queue into the wrapper shape on reload", async () => {
      const captured: CapturedRequest[] = [];
      push.__setUsageMonitorFetch(makeFetchStub(captured));

      // Simulate a pre-v4 module having left a raw UsageMonitorEvent[] (no receivedAt wrapper) plus
      // a pendingQueue entry without receivedAt, tagged with the old version so reload sees it stale.
      const shared = globalThis as unknown as {
        __usageMonitorPush?: {
          version: number;
          queue: unknown[];
          pendingQueue: unknown[];
          flushTimer: ReturnType<typeof setTimeout> | null;
        };
      };
      const st = shared.__usageMonitorPush!;
      if (st.flushTimer) clearTimeout(st.flushTimer);
      st.flushTimer = null;
      st.version = 3;
      // Old-shape queue entry = a RAW event object (no `.event`, no `.receivedAt`).
      st.queue = [{
        sourceApp: "socratic-trade",
        environment: "test",
        provider: "legacy-hmr",
        service: "llm",
        project: "socratic-trade",
        metricType: "usage",
        unit: "token",
        requests: 1,
        confidence: "estimated",
        occurredAt: "2026-07-11T00:00:00.000Z",
        idempotencyKey: "socratic-trade:llm:legacyhmr",
      }];
      // Old-shape pendingQueue entry = { event, kind, sourceId } with NO receivedAt.
      st.pendingQueue = [{
        kind: "llm",
        sourceId: "legacy-pending",
        event: {
          sourceApp: "socratic-trade",
          environment: "test",
          provider: "legacy-pending-provider",
          service: "llm",
          project: "socratic-trade",
          metricType: "usage",
          unit: "token",
          requests: 1,
          confidence: "estimated",
          occurredAt: "2026-07-11T00:00:00.000Z",
        },
      }];

      vi.resetModules();
      const reloaded = await import("../src/lib/usage-monitor-push");

      // The migrated queues must flush cleanly — no shape crash, both entries delivered.
      await reloaded.flushUsageMonitor();
      const providers = captured.flatMap((r) => r.body.events).map((e) => e.provider);
      expect(providers).toContain("legacy-hmr");
      expect(providers).toContain("legacy-pending-provider");
    });
  });
});
