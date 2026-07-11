// Outbound usage telemetry → API Usage Monitor (usage.jays.services) — server-only.
//
// Wires App B's local usage ledgers (recordLlmUsage / recordRagUsage) and its market-data /
// broker call paths to the monitor's ingest endpoint (`POST /api/ingest/usage`), so the monitor
// can see providers it structurally cannot poll (Anthropic, Voyage, Robinhood) plus real
// call-volume for the shared-quota market-data providers.
//
// DESIGN / SAFETY:
//   - Default OFF: no-op unless BOTH `USAGE_MONITOR_BASE_URL` and `USAGE_INGEST_TOKEN` are set.
//     App B must run fully standalone when the monitor is down/unconfigured — the only visible
//     effect of an outage is a "usage-monitor" row on the admin connections-health page.
//   - Fire-and-forget + never throws: the ledger functions promise "never break the caller", so
//     everything here swallows its own errors. Cost/RAG events are queued and flushed on a short
//     debounce; high-volume market-data/broker calls are aggregated per-provider and flushed as a
//     single `requests`-count event per window (never one POST per call).
//   - Health is reported via `logApiHealth({ service: "usage-monitor" })` so the operator sees the
//     connection status without the push ever affecting trading.
//
// CONTRACT: the event shape mirrors `@jaywedgeworth22/congress-trading-shared`'s
// `UsageTelemetryEventSchema` and the monitor's server-side parser
// (`API-usage-monitor/src/lib/usage-telemetry.ts`).
// MIGRATION COMPLETE (2026-07-06): types and client are now imported from the shared package.

import { logApiHealth } from "./db-health";
import {
  createUsageTelemetryClient,
  type UsageTelemetryEvent,
  type UsageTelemetryMetricType,
  type UsageTelemetryUnit,
  type UsageTelemetryBillingMode,
  type UsageTelemetryConfidence,
} from "@jaywedgeworth22/congress-trading-shared";

// Re-export shared types under the names consumers already use.
export type UsageMetricType = UsageTelemetryMetricType;
export type UsageUnit = UsageTelemetryUnit;
export type UsageBillingMode = UsageTelemetryBillingMode;
export type UsageConfidence = UsageTelemetryConfidence;
export type UsageMonitorEvent = UsageTelemetryEvent;

// ── Config (env-gated, server-only) ────────────────────────────────────────────

const SOURCE_APP = "socratic-trade";
const HEALTH_SERVICE = "usage-monitor";
const MAX_BATCH = 100; // monitor ingest caps each POST at 100 events

function trimmedEnv(name: string): string | undefined {
  const v = (process.env[name] ?? "").trim();
  return v.length > 0 ? v : undefined;
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function usageMonitorBaseUrl(): string | undefined {
  const base = trimmedEnv("USAGE_MONITOR_BASE_URL");
  return base ? base.replace(/\/+$/, "") : undefined;
}

export function usageMonitorToken(): string | undefined {
  return trimmedEnv("USAGE_INGEST_TOKEN");
}

/** Push is active only when BOTH the base URL and the ingest token are configured. */
export function usageMonitorEnabled(): boolean {
  return usageMonitorBaseUrl() !== undefined && usageMonitorToken() !== undefined;
}

function usageMonitorEnv(): string {
  return trimmedEnv("USAGE_MONITOR_ENV") ?? trimmedEnv("NODE_ENV") ?? "development";
}

function flushDelayMs(): number {
  return numEnv("USAGE_MONITOR_FLUSH_MS", 2000);
}


// ── State (globalThis-pinned so Next.js HMR module duplication can't split it) ──

interface CallVolumeEntry {
  windowId: string;
  provider: string;
  service?: string;
  keySource?: string;
  userId?: string;
  requests: number;
  successes: number;
  failures: number;
}

interface PendingUsageEvent {
  event: UsageMonitorEvent;
  kind: string;
  sourceId: string;
}

interface PushState {
  version: number;
  /** New events awaiting edge-safe SHA-256 delivery identity resolution. */
  pendingQueue: PendingUsageEvent[];
  /** Fully resolved events retained verbatim across ambiguous delivery retries. */
  queue: UsageMonitorEvent[];
  callVolume: Map<string, CallVolumeEntry>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Test seam: overrides global fetch when set. */
  fetchImpl: typeof fetch | null;
  retryAttempt: number;
}

const host = globalThis as unknown as { __usageMonitorPush?: PushState };
const STATE_VERSION = 3;
const priorState = host.__usageMonitorPush;
const staleState = priorState !== undefined && priorState.version !== STATE_VERSION;
if (staleState && priorState.flushTimer) {
  // A preserved HMR timer closes over the old module implementation. Cancel it
  // before reusing the queue/map so the current flush logic owns every send.
  clearTimeout(priorState.flushTimer);
  priorState.flushTimer = null;
}
const state: PushState =
  priorState ??
  (host.__usageMonitorPush = {
    version: STATE_VERSION,
    pendingQueue: [],
    queue: [],
    callVolume: new Map(),
    flushTimer: null,
    fetchImpl: null,
    retryAttempt: 0,
  });
state.version = STATE_VERSION;
state.pendingQueue ??= [];
state.retryAttempt ??= 0;

if (
  staleState &&
  (state.pendingQueue.length > 0 || state.queue.length > 0 || state.callVolume.size > 0)
) {
  scheduleFlush();
}

// ── Enqueue: discrete cost events (LLM / RAG) ──────────────────────────────────

/**
 * Record one LLM call's usage/cost. Called from `recordLlmUsage` AFTER the local ledger write.
 * Cost + token totals are passed in (already computed by the caller) so this module never imports
 * `llm-usage.ts` — avoids a circular import and re-computation.
 */
export function pushLlmUsage(entry: {
  /** Stable ID of the local llm_usage row backing this delivery. */
  sourceEventId?: string;
  /** Stable timestamp persisted on the same local ledger row. */
  occurredAt?: string;
  provider: string;
  model?: string;
  context?: string;
  userId: string;
  keySource: string;
  keyRef?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}): void {
  if (!usageMonitorEnabled()) return;
  try {
    const hasCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
    enqueuePending({
      sourceApp: SOURCE_APP,
      environment: usageMonitorEnv(),
      provider: entry.provider,
      service: "llm",
      label: entry.context,
      keyRef: entry.keyRef,
      billingMode: "estimated",
      metricType: hasCost ? "cost" : "usage",
      quantity: entry.totalTokens,
      unit: "token",
      costUsd: hasCost ? entry.costUsd : undefined,
      requests: 1,
      confidence: "estimated",
      occurredAt: entry.occurredAt ?? new Date().toISOString(),
      metadata: cleanMetadata({
        model: entry.model ?? null,
        context: entry.context ?? null,
        userId: entry.userId,
        keySource: entry.keySource,
        promptTokens: entry.promptTokens ?? null,
        completionTokens: entry.completionTokens ?? null,
      }),
    }, "llm", entry.sourceEventId);
  } catch {
    /* telemetry must never break the caller */
  }
}

/**
 * Record one RAG (Voyage / Pinecone) op's usage/cost. Called from `recordRagUsage` after the local
 * ledger write. Cost is passed in (already computed by the caller).
 */
export function pushRagUsage(entry: {
  /** Stable ID of the local rag_usage row backing this delivery. */
  sourceEventId?: string;
  /** Stable timestamp persisted on the same local ledger row. */
  occurredAt?: string;
  provider: string;
  operation: string;
  model?: string;
  userId: string;
  tokensIn?: number;
  tokensOut?: number;
  batchCount?: number;
  costUsd?: number;
}): void {
  if (!usageMonitorEnabled()) return;
  try {
    const hasCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
    const isPinecone = entry.provider === "pinecone";
    const quantity = isPinecone ? (entry.tokensIn ?? 0) : (entry.tokensIn ?? 0) + (entry.tokensOut ?? 0);
    // Voyage embed/rerank quantities are token estimates. Pinecone query/upsert quantities are
    // Read/Write Units in tokensIn, with records kept separately in metadata.
    const unit: UsageUnit = isPinecone ? "credit" : "token";
    enqueuePending({
      sourceApp: SOURCE_APP,
      environment: usageMonitorEnv(),
      provider: entry.provider,
      service: "rag",
      label: entry.operation,
      keyRef: undefined, // RAG keys are app-funded; no per-attached-key fingerprint today
      billingMode: "estimated",
      metricType: hasCost ? "cost" : "usage",
      quantity: quantity > 0 ? quantity : undefined,
      unit,
      costUsd: hasCost ? entry.costUsd : undefined,
      requests: 1,
      confidence: "estimated",
      occurredAt: entry.occurredAt ?? new Date().toISOString(),
      metadata: cleanMetadata({
        model: entry.model ?? null,
        operation: entry.operation,
        userId: entry.userId,
        batchCount: entry.batchCount ?? null,
        recordCount: isPinecone ? entry.tokensOut ?? null : null,
      }),
    }, "rag", entry.sourceEventId);
  } catch {
    /* telemetry must never break the caller */
  }
}

function maskAccountNumber(acc: string): string {
  const clean = acc.trim();
  if (clean.length <= 4) return clean;
  return `...${clean.slice(-4)}`;
}

/**
 * Record broker account balances and limits.
 */
export function pushBrokerBalance(entry: {
  provider: string;
  userId: string;
  accountNumber: string;
  cash?: number;
  buyingPower?: number;
  equity?: number;
}): void {
  if (!usageMonitorEnabled()) return;
  try {
    const occurredAt = new Date().toISOString();
    const snapshotId = randomDeliveryId();
    const maskedAcc = maskAccountNumber(entry.accountNumber);
    if (typeof entry.cash === "number") {
      enqueuePending({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        keyRef: `${maskedAcc}:cash`,
        billingMode: "actual",
        metricType: "balance",
        quantity: entry.cash,
        unit: "usd",
        confidence: "actual",
        occurredAt,
        metadata: cleanMetadata({
          userId: entry.userId,
          accountNumber: maskedAcc,
          metric: "cash"
        }),
      }, "broker-balance", `${snapshotId}:cash`);
    }
    if (typeof entry.buyingPower === "number") {
      enqueuePending({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        keyRef: `${maskedAcc}:buyingPower`,
        billingMode: "actual",
        metricType: "limit",
        quantity: entry.buyingPower,
        unit: "usd",
        confidence: "actual",
        occurredAt,
        metadata: cleanMetadata({
          userId: entry.userId,
          accountNumber: maskedAcc,
          metric: "buyingPower"
        }),
      }, "broker-balance", `${snapshotId}:buying-power`);
    }
    if (typeof entry.equity === "number") {
      enqueuePending({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        keyRef: `${maskedAcc}:equity`,
        billingMode: "actual",
        metricType: "balance",
        quantity: entry.equity,
        unit: "usd",
        confidence: "actual",
        occurredAt,
        metadata: cleanMetadata({
          userId: entry.userId,
          accountNumber: maskedAcc,
          metric: "equity"
        }),
      }, "broker-balance", `${snapshotId}:equity`);
    }
  } catch {
    /* telemetry must never break the caller */
  }
}

// ── Aggregate: market-data / broker call-volume ────────────────────────────────

/**
 * Count one external market-data or broker API call. Called from the central `fetchWithRetry`
 * wrapper (`data-providers.ts`) and the broker choke points (`alpaca.ts`, `robinhood.ts`). This is
 * on a hot path, so it only mutates an in-memory per-provider counter — the counts are flushed as a
 * single aggregated `requests`-count event per provider per window (never one POST per call).
 */
export function recordProviderCall(
  provider: string,
  opts: { service?: string; ok?: boolean; keySource?: string; userId?: string } = {}
): void {
  if (!usageMonitorEnabled()) return;
  // Never re-count the telemetry channel's own health calls (would loop).
  if (provider === HEALTH_SERVICE) return;
  try {
    // Key by credential lane too, so a user's own market-data key isn't conflated with shared/
    // operator quota in the monitor.
    const key = [provider, opts.service ?? "", opts.keySource ?? "", opts.userId ?? ""].join("|");
    const entry =
      state.callVolume.get(key) ??
      {
        windowId: randomDeliveryId(),
        provider,
        service: opts.service,
        keySource: opts.keySource,
        userId: opts.userId,
        requests: 0,
        successes: 0,
        failures: 0,
      };
    entry.requests += 1;
    if (opts.ok === true) entry.successes += 1;
    else if (opts.ok === false) entry.failures += 1;
    state.callVolume.set(key, entry);
    scheduleFlush();
  } catch {
    /* telemetry must never break the caller */
  }
}

// ── Queue / flush plumbing ─────────────────────────────────────────────────────

function enqueuePending(
  event: UsageMonitorEvent,
  kind: string,
  sourceId?: string
): void {
  state.pendingQueue.push({
    event,
    kind,
    sourceId: sourceId?.trim() || randomDeliveryId(),
  });
  scheduleFlush();
}

function scheduleFlush(delayMs = flushDelayMs()): void {
  if (state.flushTimer) return;
  const timer = setTimeout(() => {
    state.flushTimer = null;
    void flushUsageMonitor();
  }, delayMs);
  // Don't keep the process alive just for a pending telemetry flush.
  (timer as { unref?: () => void }).unref?.();
  state.flushTimer = timer;
}

function drainCallVolume(now: string): PendingUsageEvent[] {
  const events: PendingUsageEvent[] = [];
  for (const entry of state.callVolume.values()) {
    if (entry.requests <= 0) continue;
    events.push({
      kind: "provider-call-volume",
      // HMR can preserve a pre-upgrade global map entry without windowId.
      sourceId: entry.windowId || randomDeliveryId(),
      event: {
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: entry.service,
        billingMode: "actual",
        metricType: "usage",
        unit: "request",
        requests: entry.requests,
        confidence: "actual",
        occurredAt: now,
        metadata: cleanMetadata({
          successes: entry.successes,
          failures: entry.failures,
          keySource: entry.keySource ?? null,
          userId: entry.userId ?? null,
        }),
      },
    });
  }
  state.callVolume.clear();
  return events;
}

async function resolvePendingEvents(
  pending: PendingUsageEvent[]
): Promise<UsageMonitorEvent[]> {
  return Promise.all(
    pending.map(async ({ event, kind, sourceId }) => ({
      ...event,
      idempotencyKey: await telemetryIdempotencyKey(kind, sourceId),
    }))
  );
}

/**
 * Flush all buffered events (discrete cost events + aggregated call-volume) to the monitor. Batched
 * at MAX_BATCH per POST. Never throws. Exported for tests and internal scheduling.
 */
export async function flushUsageMonitor(): Promise<void> {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (!usageMonitorEnabled()) {
    // Drop anything buffered while disabled so it can't leak later if the env is toggled mid-process.
    state.pendingQueue.length = 0;
    state.queue.length = 0;
    state.callVolume.clear();
    return;
  }

  const now = new Date().toISOString();
  const unresolved = state.pendingQueue
    .splice(0, state.pendingQueue.length)
    .concat(drainCallVolume(now));
  let resolved: UsageMonitorEvent[];
  try {
    resolved = await resolvePendingEvents(unresolved);
  } catch {
    // Web Crypto is expected in every supported runtime. If it is temporarily
    // unavailable, retain the original descriptors rather than sending events
    // without their stable delivery identity.
    state.pendingQueue.unshift(...unresolved);
    scheduleFlush();
    return;
  }
  const pending = state.queue.splice(0, state.queue.length).concat(resolved);
  if (pending.length === 0) return;

  for (let i = 0; i < pending.length; i += MAX_BATCH) {
    const sent = await postBatch(pending.slice(i, i + MAX_BATCH));
    if (!sent) {
      // Keep the exact event objects — including explicit key + occurredAt —
      // so an ambiguous accepted-then-disconnected response retries safely.
      state.queue.unshift(...pending.slice(i));
      state.retryAttempt += 1;
      const retryDelay = Math.min(
        60_000,
        flushDelayMs() * 2 ** Math.min(state.retryAttempt - 1, 5)
      );
      scheduleFlush(retryDelay);
      return;
    }
  }
  state.retryAttempt = 0;
}

async function postBatch(events: UsageMonitorEvent[]): Promise<boolean> {
  const baseUrl = usageMonitorBaseUrl();
  const token = usageMonitorToken();
  if (!baseUrl || !token || events.length === 0) return true;

  const fetchImpl = state.fetchImpl ?? fetch;
  const start = Date.now();
  try {
    const client = createUsageTelemetryClient({ baseUrl, token, fetchImpl });
    await client.send(events);
    logApiHealth({
      service: HEALTH_SERVICE,
      ok: true,
      latencyMs: Date.now() - start,
    });
    return true;
  } catch (err) {
    logApiHealth({
      service: HEALTH_SERVICE,
      ok: false,
      latencyMs: Date.now() - start,
      errorText: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Drop null/undefined-ish values so the monitor's 50-key/500-char metadata cap isn't wasted. */
function cleanMetadata(
  raw: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean | null> | undefined {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Delivery identity, separate from the shared five-field fallback. Source-ledger
 * IDs make discrete events stable; a UUID allocated once per aggregate window
 * makes same-flush provider lanes unique even though they share occurredAt.
 */
async function telemetryIdempotencyKey(
  kind: string,
  sourceId: string = randomDeliveryId()
): Promise<string> {
  const normalizedSourceId = sourceId.trim() || randomDeliveryId();
  const encoded = new TextEncoder().encode(`${kind}\0${normalizedSourceId}`);
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", encoded)
  );
  const digest = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${SOURCE_APP}:${kind}:${digest}`;
}

function randomDeliveryId(): string {
  return globalThis.crypto.randomUUID();
}

// ── Test seams ─────────────────────────────────────────────────────────────────

/** Inject a fetch stub for tests. Pass null to restore the real fetch. */
export function __setUsageMonitorFetch(fetchImpl: typeof fetch | null): void {
  state.fetchImpl = fetchImpl;
}

/** Clear all buffered state (tests). */
export function __resetUsageMonitorState(): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.pendingQueue.length = 0;
  state.queue.length = 0;
  state.callVolume.clear();
  state.fetchImpl = null;
  state.retryAttempt = 0;
}
