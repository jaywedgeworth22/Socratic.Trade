import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = path.join(tmpdir(), `socratic-usage-replay-${randomUUID()}`);
const tmpDbPath = path.join(tmpDir, "test.db");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
process.env.DATABASE_URL = `file:${tmpDbPath}`;

const push = await import("../src/lib/usage-monitor-push");
const replay = await import("../src/lib/usage-monitor-replay");
const {
  getDb,
  markProviderDispatchStarted,
  reserveProviderDispatch
} = await import("../src/lib/db");

const BASE_URL = "https://usage.example.test";

interface CapturedRequest {
  body: { events: Array<Record<string, unknown>> };
  rawBody: string;
}

function telemetryKey(kind: "llm" | "rag" | "provider-dispatch", sourceId: string): string {
  const digest = createHash("sha256")
    .update(`${kind}\0${sourceId}`)
    .digest("hex");
  return `socratic-trade:${kind}:${digest}`;
}

function fetchStub(captured: CapturedRequest[], ok = true): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const rawBody = String(init?.body ?? "{}");
    captured.push({ rawBody, body: JSON.parse(rawBody) });
    if (!ok) return new Response("unavailable", { status: 503 });
    const eventCount = captured.at(-1)?.body.events.length ?? 0;
    return new Response(JSON.stringify({ ok: true, accepted: eventCount }), { status: 202 });
  }) as unknown as typeof fetch;
}

function insertLlm(input: {
  id: string;
  createdAt: string;
  provider?: string;
  costUsd?: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO llm_usage (
        id, user_id, provider, model, context, key_source, key_ref,
        prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at
      ) VALUES (?, 'local', ?, 'gemini-2.5-pro', 'strategy', 'operator', 'key-ref', 80, 20, 100, ?, ?)`
    )
    .run(input.id, input.provider ?? "gemini", input.costUsd ?? null, input.createdAt);
}

function insertRag(input: {
  id: string;
  createdAt: string;
  provider?: string;
  costUsd?: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO rag_usage (
        id, user_id, operation, provider, model, tokens_in, tokens_out,
        batch_count, cost_est_usd, created_at
      ) VALUES (?, 'local', 'embed', ?, 'voyage-finance-2', 120, 0, 1, ?, ?)`
    )
    .run(input.id, input.provider ?? "voyage", input.costUsd ?? null, input.createdAt);
}

function storedWatermark(key: string): { createdAt: string; id: string } | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

beforeEach(() => {
  push.__resetUsageMonitorState();
  replay.__resetUsageMonitorReplayState();
  process.env.USAGE_MONITOR_BASE_URL = BASE_URL;
  process.env.USAGE_INGEST_TOKEN = "test-token";
  process.env.USAGE_MONITOR_ENV = "test";
  getDb().exec(
    "DELETE FROM llm_usage; DELETE FROM rag_usage; " +
    "DELETE FROM provider_usage_outbox; DELETE FROM provider_dispatch_attempts;"
  );
  getDb()
    .prepare("DELETE FROM settings WHERE key IN (?, ?, ?)")
    .run(
      replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm,
      replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag,
      replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider
    );
});

afterEach(() => {
  push.__resetUsageMonitorState();
  replay.__resetUsageMonitorReplayState();
  delete process.env.USAGE_MONITOR_BASE_URL;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_MONITOR_ENV;
  delete process.env.USAGE_MONITOR_BREAKER_THRESHOLD;
  delete process.env.USAGE_MONITOR_BREAKER_BASE_MS;
  delete process.env.USAGE_MONITOR_BREAKER_MAX_MS;
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${tmpDbPath}${suffix}`); } catch { /* best-effort */ }
  }
});

describe("usage monitor durable replay", () => {
  it("replays historical LLM and RAG costs with raw providers, project attribution, and row IDs", async () => {
    insertLlm({
      id: "llm-gemini-paid",
      createdAt: "2026-07-10T12:00:00.000Z",
      provider: "gemini",
      costUsd: 0.42,
    });
    insertRag({
      id: "rag-voyage-paid",
      createdAt: "2026-07-10T12:01:00.000Z",
      provider: "voyage",
      costUsd: 0.003,
    });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay();

    expect(result).toEqual({
      configured: true,
      llm: { sent: 1, complete: true, failed: false },
      rag: { sent: 1, complete: true, failed: false },
      provider: { sent: 0, complete: true, failed: false },
    });
    const events = captured.flatMap((request) => request.body.events);
    expect(events).toHaveLength(2);
    const llm = events.find((event) => event.service === "llm")!;
    expect(llm).toMatchObject({
      sourceApp: "socratic-trade",
      project: "socratic-trade",
      provider: "gemini",
      costUsd: 0.42,
      metricType: "cost",
      occurredAt: "2026-07-10T12:00:00.000Z",
      idempotencyKey: telemetryKey("llm", "llm-gemini-paid"),
    });
    const rag = events.find((event) => event.service === "rag")!;
    expect(rag).toMatchObject({
      project: "socratic-trade",
      provider: "voyage",
      costUsd: 0.003,
      occurredAt: "2026-07-10T12:01:00.000Z",
      idempotencyKey: telemetryKey("rag", "rag-voyage-paid"),
    });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toEqual({
      createdAt: "2026-07-10T12:00:00.000Z",
      id: "llm-gemini-paid",
    });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag)).toEqual({
      createdAt: "2026-07-10T12:01:00.000Z",
      id: "rag-voyage-paid",
    });
  });

  it("orders equal timestamps by row ID and safely overlaps the last acknowledged row", async () => {
    const occurredAt = "2026-07-10T13:00:00.000Z";
    insertLlm({ id: "llm-b", createdAt: occurredAt, costUsd: 0.02 });
    insertLlm({ id: "llm-a", createdAt: occurredAt, costUsd: 0.01 });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const first = await replay.runUsageMonitorReplay({ pageSize: 1, maxPagesPerLedger: 1 });
    expect(first.llm).toEqual({ sent: 1, complete: false, failed: false });
    expect(captured[0]!.body.events[0]!.idempotencyKey).toBe(telemetryKey("llm", "llm-a"));
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)?.id).toBe("llm-a");

    captured.length = 0;
    const second = await replay.runUsageMonitorReplay({ pageSize: 2, maxPagesPerLedger: 2 });
    expect(second.llm).toEqual({ sent: 2, complete: true, failed: false });
    expect(captured[0]!.body.events.map((event) => event.idempotencyKey)).toEqual([
      telemetryKey("llm", "llm-a"),
      telemetryKey("llm", "llm-b"),
    ]);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)?.id).toBe("llm-b");

    captured.length = 0;
    const third = await replay.runUsageMonitorReplay();
    expect(third.llm).toEqual({ sent: 1, complete: true, failed: false });
    expect(captured[0]!.body.events[0]!.idempotencyKey).toBe(telemetryKey("llm", "llm-b"));
  });

  it("does not advance a watermark on ambiguous failure and reconstructs the same payload", async () => {
    insertLlm({
      id: "llm-retry",
      createdAt: "2026-07-10T14:00:00.000Z",
      costUsd: 0.25,
    });
    const failed: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(failed, false));

    const first = await replay.runUsageMonitorReplay();
    expect(first.llm).toEqual({ sent: 0, complete: false, failed: true });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toBeNull();

    const retried: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(retried));
    const second = await replay.runUsageMonitorReplay();
    expect(second.llm).toEqual({ sent: 1, complete: true, failed: false });
    expect(retried[0]!.rawBody).toBe(failed[0]!.rawBody);
  });

  it("reconciles a crash-left dispatched provider call as unknown and replays it idempotently", async () => {
    const reserved = reserveProviderDispatch({
      provider: "fmp",
      operation: "earnings-transcript-dates",
      credentialRef: "fmp-key:test",
      userId: "local",
      now: "2026-07-10T12:00:00.000Z"
    });
    expect(reserved.admitted).toBe(true);
    if (!reserved.admitted) throw new Error("Expected provider reservation admission.");
    markProviderDispatchStarted(reserved.attemptId, "2026-07-10T12:00:01.000Z");

    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const first = await replay.runUsageMonitorReplay();

    expect(first.provider).toEqual({ sent: 1, complete: true, failed: false });
    const event = captured.flatMap((request) => request.body.events)
      .find((candidate) => candidate.service === "provider-dispatch");
    expect(event).toMatchObject({
      provider: "fmp",
      service: "provider-dispatch",
      label: "earnings-transcript-dates",
      requests: 1,
      confidence: "estimated",
      metadata: { outcome: "unknown", unknownOutcome: true, userId: "local" },
      idempotencyKey: telemetryKey(
        "provider-dispatch",
        `provider-attempt:${reserved.attemptId}`
      )
    });
    expect(getDb().prepare(
      "SELECT status, outcome_code FROM provider_dispatch_attempts WHERE id = ?"
    ).get(reserved.attemptId)).toEqual({
      status: "unknown",
      outcome_code: "stale-owner-unresolved"
    });

    const firstRaw = captured[0]!.rawBody;
    captured.length = 0;
    const second = await replay.runUsageMonitorReplay();
    expect(second.provider).toEqual({ sent: 1, complete: true, failed: false });
    expect(captured[0]!.rawBody).toBe(firstRaw);
  });

  it("does not regress a watermark advanced by an overlapping process", async () => {
    const older = "2026-07-10T14:30:00.000Z";
    const newer = "2026-07-10T14:31:00.000Z";
    insertLlm({ id: "llm-older", createdAt: older, costUsd: 0.1 });
    insertLlm({ id: "llm-newer", createdAt: newer, costUsd: 0.2 });
    push.__setUsageMonitorFetch((async () => {
      // Simulate a second process ACKing the newer row while this process is awaiting its POST.
      getDb()
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        )
        .run(
          replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm,
          JSON.stringify({ createdAt: newer, id: "llm-newer" }),
          new Date().toISOString()
        );
      return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 202 });
    }) as unknown as typeof fetch);

    const result = await replay.runUsageMonitorReplay({ pageSize: 1, maxPagesPerLedger: 1 });

    expect(result.llm).toEqual({ sent: 1, complete: false, failed: false });
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toEqual({
      createdAt: newer,
      id: "llm-newer",
    });
  });

  it("starts one immediate replay and one guarded interval only when configured", async () => {
    insertLlm({
      id: "llm-startup",
      createdAt: "2026-07-10T15:00:00.000Z",
      costUsd: 0.05,
    });
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    replay.startUsageMonitorReplay();
    replay.startUsageMonitorReplay();
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(intervalSpy).toHaveBeenCalledTimes(1);

    replay.__resetUsageMonitorReplayState();
    delete process.env.USAGE_INGEST_TOKEN;
    replay.startUsageMonitorReplay();
    expect(intervalSpy).toHaveBeenCalledTimes(1);
  });

  it("shares the live-push circuit breaker: a tripped breaker suppresses replay's own delivery attempts too", async () => {
    process.env.USAGE_MONITOR_BREAKER_THRESHOLD = "1";
    process.env.USAGE_MONITOR_BREAKER_BASE_MS = "60000";
    process.env.USAGE_MONITOR_BREAKER_MAX_MS = "60000";
    insertLlm({ id: "llm-breaker-shared", createdAt: "2026-07-10T16:00:00.000Z", costUsd: 0.1 });

    // Trip the breaker via the live-push lane (a plain failed flush, not replay).
    let liveAttempts = 0;
    push.__setUsageMonitorFetch((async () => {
      liveAttempts += 1;
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    push.pushLlmUsage({ sourceEventId: "trip-it", provider: "openai", userId: "local", keySource: "operator", totalTokens: 1 });
    await push.flushUsageMonitor();
    expect(liveAttempts).toBe(1);

    // Now point at a fetch stub that would succeed if called — the open breaker must stop replay
    // from ever reaching it, proving the two lanes share one breaker instead of hammering
    // independently (replay's fixed 60s interval would otherwise keep probing on its own cadence).
    const captured: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(captured));

    const result = await replay.runUsageMonitorReplay();
    expect(result.llm.failed).toBe(true);
    expect(captured).toHaveLength(0);
    expect(storedWatermark(replay.USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm)).toBeNull();
  });

  it("records usage-monitor health from the replay lane on failure AND recovery (not just a breaker trip)", async () => {
    // Scope health assertions to this test's rows.
    getDb().prepare("DELETE FROM api_health_log WHERE service = 'usage-monitor'").run();
    insertLlm({ id: "llm-health-truth", createdAt: "2026-07-10T17:00:00.000Z", costUsd: 0.05 });

    const healthRows = () =>
      getDb()
        .prepare("SELECT ok FROM api_health_log WHERE service = 'usage-monitor' ORDER BY ts DESC, rowid DESC")
        .all() as Array<{ ok: number }>;

    // Replay is the FIRST/only lane to hit a down monitor — without the fix this would open the
    // shared breaker but leave the admin health row stale-healthy.
    const failed: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(failed, false));
    const first = await replay.runUsageMonitorReplay();
    expect(first.llm.failed).toBe(true);
    expect(failed.length).toBeGreaterThan(0); // it actually attempted the send
    const afterFail = healthRows();
    expect(afterFail.length).toBeGreaterThan(0);
    expect(afterFail[0]!.ok).toBe(0); // a real FAILURE was recorded, not just a silent breaker trip

    // Monitor recovers. The watermark never advanced on failure, so replay re-sends the same row and
    // records recovery from the replay lane.
    const okReq: CapturedRequest[] = [];
    push.__setUsageMonitorFetch(fetchStub(okReq));
    const second = await replay.runUsageMonitorReplay();
    expect(second.llm.failed).toBe(false);
    const afterOk = healthRows();
    expect(afterOk[0]!.ok).toBe(1); // recovery recorded from the replay lane
  });
});
