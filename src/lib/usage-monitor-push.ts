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
  UsageTelemetryEventSchema,
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
const PROJECT = "socratic-trade";
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

// ── Circuit breaker (dead-receiver protection) ──────────────────────────────────
//
// The 2026-07 API-usage-monitor outage taught us that a plain capped-retry loop still POSTs on
// every flush/replay tick forever, which is exactly the "hammer a dead endpoint" pattern that ran
// up a 200GB Render bandwidth bill. The breaker below sits in front of every real network attempt
// (postBatch + sendUsageMonitorBatch): after enough consecutive failures it fully suppresses
// delivery for a backoff window (no fetch call at all, not even a fast-failing one) and only lets a
// single "half-open" probe through once that window elapses, so a dead receiver is checked
// occasionally instead of continuously. A success at any point fully resets it.

/** Consecutive failures required before the circuit opens (suppresses delivery). */
function breakerThreshold(): number {
  return numEnv("USAGE_MONITOR_BREAKER_THRESHOLD", 3);
}

/** Initial open-circuit window once the breaker trips. */
function breakerBaseMs(): number {
  return numEnv("USAGE_MONITOR_BREAKER_BASE_MS", 30_000);
}

/** Cap on the open-circuit window — the longest we'll go between probes during a sustained outage. */
function breakerMaxMs(): number {
  return numEnv("USAGE_MONITOR_BREAKER_MAX_MS", 15 * 60_000);
}

/** Cap on total buffered (unsent) events across both queues; see trimBufferedEvents(). */
function queueMaxEvents(): number {
  return numEnv("USAGE_MONITOR_QUEUE_MAX_EVENTS", 500);
}

/** TTL for buffered events (by buffer-residency time, not occurredAt); see trimBufferedEvents(). */
function queueTtlMs(): number {
  return numEnv("USAGE_MONITOR_QUEUE_TTL_MS", 60 * 60_000);
}

/** Max distinct provider/service/key/user lanes held in the callVolume aggregate; see recordProviderCall(). */
function callVolumeMaxKeys(): number {
  return numEnv("USAGE_MONITOR_CALLVOLUME_MAX_KEYS", 2000);
}

/**
 * Per-attempt wall-clock timeout on the LIVE push (postBatch). Without this, a monitor that accepts
 * the TCP connection but never responds leaves `client.send` awaiting forever — the attempt never
 * fails, so the breaker never trips and the queue never drains. That is exactly the half-up outage
 * we just had in prod, so a bounded timeout that CONVERTS a hang into a recorded failure is load-
 * bearing, not cosmetic. (The replay lane has its own REPLAY_SEND_TIMEOUT_MS for the same reason.)
 */
function pushTimeoutMs(): number {
  return numEnv("USAGE_MONITOR_PUSH_TIMEOUT_MS", 10_000);
}

interface BreakerState {
  consecutiveFailures: number;
  /** Epoch ms until which delivery is suppressed. 0 means the circuit is closed. */
  openUntil: number;
  /** True while a single half-open probe attempt is outstanding. */
  probing: boolean;
}

/**
 * Gate every real delivery attempt through the breaker. Returns false (no attempt allowed) while
 * the circuit is open; returns true when closed, or for exactly one concurrent half-open probe once
 * the open window has elapsed. Callers that receive `true` MUST report the outcome via
 * breakerRecordResult so `probing` doesn't leak permanently true.
 */
function breakerAllowsAttempt(now: number): boolean {
  const breaker = state.breaker;
  if (breaker.openUntil === 0 || now >= breaker.openUntil) {
    if (breaker.openUntil !== 0 && breaker.probing) return false; // another probe already in flight
    if (breaker.openUntil !== 0) breaker.probing = true; // half-open: this is the one allowed probe
    return true;
  }
  return false; // circuit open: suppress the attempt entirely, no network call
}

/** Record the outcome of a delivery attempt that breakerAllowsAttempt permitted. */
function breakerRecordResult(ok: boolean, now: number): void {
  const breaker = state.breaker;
  breaker.probing = false;
  if (ok) {
    breaker.consecutiveFailures = 0;
    breaker.openUntil = 0;
    return;
  }
  breaker.consecutiveFailures += 1;
  const threshold = breakerThreshold();
  if (breaker.consecutiveFailures < threshold) return; // below trip threshold: keep the normal cadence
  const exponent = Math.min(breaker.consecutiveFailures - threshold, 10);
  const backoff = Math.min(breakerMaxMs(), breakerBaseMs() * 2 ** exponent);
  breaker.openUntil = now + backoff;
}

/**
 * True when an item has sat in the in-memory buffer longer than the TTL. Deliberately keyed off
 * `receivedAt` (wall-clock time the item entered THIS process's buffer) rather than the event's
 * business `occurredAt` — a replayed/backfilled event can legitimately carry an old `occurredAt`
 * while having just arrived here, and that must not make it look stale on arrival.
 */
function isStaleBuffered(receivedAt: number, ttlMs: number, now: number): boolean {
  return now - receivedAt > ttlMs;
}

/**
 * Bound the in-memory failure buffer so a multi-day receiver outage can't grow ST's own memory
 * without limit. This is safe to trim aggressively: llm/rag/provider-dispatch events dropped here
 * are still recoverable — the durable DB-backed ledgers replay them independently via
 * usage-monitor-replay.ts. Only ephemeral broker-balance snapshots have no such backstop, and losing
 * a stale one is harmless (the next portfolio fetch pushes a fresh reading).
 */
function trimBufferedEvents(now: number): void {
  const ttlMs = queueTtlMs();
  if (ttlMs > 0) {
    state.queue = state.queue.filter((q) => !isStaleBuffered(q.receivedAt, ttlMs, now));
    state.pendingQueue = state.pendingQueue.filter((p) => !isStaleBuffered(p.receivedAt, ttlMs, now));
  }
  const maxEvents = queueMaxEvents();
  if (maxEvents <= 0) return;
  let overflow = state.pendingQueue.length + state.queue.length - maxEvents;
  if (overflow <= 0) return;
  // Prefer dropping already-failed retries over fresh, not-yet-attempted events.
  if (overflow > 0 && state.queue.length > 0) {
    const drop = Math.min(overflow, state.queue.length);
    state.queue.splice(0, drop);
    overflow -= drop;
  }
  if (overflow > 0 && state.pendingQueue.length > 0) {
    const drop = Math.min(overflow, state.pendingQueue.length);
    state.pendingQueue.splice(0, drop);
    overflow -= drop;
  }
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
  /** Wall-clock arrival time in this buffer; see isStaleBuffered(). */
  receivedAt: number;
}

/** A fully resolved event retained for retry, paired with when it first entered the buffer. */
interface QueuedUsageEvent {
  event: UsageMonitorEvent;
  receivedAt: number;
}

interface PushState {
  version: number;
  /** New events awaiting edge-safe SHA-256 delivery identity resolution. */
  pendingQueue: PendingUsageEvent[];
  /** Fully resolved events retained verbatim across ambiguous delivery retries. */
  queue: QueuedUsageEvent[];
  callVolume: Map<string, CallVolumeEntry>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Test seam: overrides global fetch when set. */
  fetchImpl: typeof fetch | null;
  breaker: BreakerState;
}

const host = globalThis as unknown as { __usageMonitorPush?: PushState };
// v4: `queue` entries changed from raw UsageMonitorEvent to the { event, receivedAt } wrapper and
// `pendingQueue` entries gained `receivedAt`. Bumping forces the stale-timer cancellation below and
// pairs with normalizeRetainedQueues() so an HMR reload from a pre-v4 module can't feed old-shape
// entries into the new flush path.
const STATE_VERSION = 4;
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
    breaker: { consecutiveFailures: 0, openUntil: 0, probing: false },
  });
if (priorState) normalizeRetainedQueues(priorState);
state.version = STATE_VERSION;
state.pendingQueue ??= [];
state.breaker ??= { consecutiveFailures: 0, openUntil: 0, probing: false };

if (
  staleState &&
  (state.pendingQueue.length > 0 || state.queue.length > 0 || state.callVolume.size > 0)
) {
  scheduleFlush();
}

/**
 * Coerce queues retained across an HMR reload into the current wrapper shapes. A pre-v4 module
 * stored `queue` as raw UsageMonitorEvent[] and `pendingQueue` entries without `receivedAt`; the
 * v4+ flush path reads `.event` / `.receivedAt` off every entry, so an un-migrated old-shape entry
 * would throw or send a shapeless payload on hot-reload. Dev-only concern, but cheap to make safe.
 * A raw event is discriminated by the absence of a nested `.event` object.
 */
function normalizeRetainedQueues(prior: PushState): void {
  const now = Date.now();
  if (Array.isArray(prior.queue)) {
    prior.queue = prior.queue.map((entry) => {
      const wrapper = entry as Partial<QueuedUsageEvent>;
      if (wrapper && typeof wrapper.event === "object" && wrapper.event !== null) {
        return { event: wrapper.event, receivedAt: typeof wrapper.receivedAt === "number" ? wrapper.receivedAt : now };
      }
      // Old shape: `entry` IS the raw event.
      return { event: entry as unknown as UsageMonitorEvent, receivedAt: now };
    });
  }
  if (Array.isArray(prior.pendingQueue)) {
    prior.pendingQueue = prior.pendingQueue.map((entry) => ({
      ...entry,
      receivedAt: typeof entry.receivedAt === "number" ? entry.receivedAt : now,
    }));
  }
}

// ── Enqueue: discrete cost events (LLM / RAG) ──────────────────────────────────

/**
 * Record one LLM call's usage/cost. Called from `recordLlmUsage` AFTER the local ledger write.
 * Cost + token totals are passed in (already computed by the caller) so this module never imports
 * `llm-usage.ts` — avoids a circular import and re-computation.
 */
export interface LlmUsageMonitorEntry {
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
}

function llmUsageEvent(entry: LlmUsageMonitorEntry): UsageMonitorEvent {
  const hasCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
  return {
    sourceApp: SOURCE_APP,
    environment: usageMonitorEnv(),
    provider: entry.provider,
    service: "llm",
    project: PROJECT,
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
  };
}

export function pushLlmUsage(entry: LlmUsageMonitorEntry): void {
  if (!usageMonitorEnabled()) return;
  try {
    enqueuePending(llmUsageEvent(entry), "llm", entry.sourceEventId);
  } catch {
    /* telemetry must never break the caller */
  }
}

/** Build the exact deterministic event used to replay one persisted llm_usage row. */
export async function createLlmUsageMonitorEvent(
  entry: LlmUsageMonitorEntry & { sourceEventId: string; occurredAt: string }
): Promise<UsageMonitorEvent> {
  return {
    ...llmUsageEvent(entry),
    idempotencyKey: await telemetryIdempotencyKey("llm", entry.sourceEventId),
  };
}

/**
 * Record one RAG (Voyage / Pinecone) op's usage/cost. Called from `recordRagUsage` after the local
 * ledger write. Cost is passed in (already computed by the caller).
 */
export interface RagUsageMonitorEntry {
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
}

function ragUsageEvent(entry: RagUsageMonitorEntry): UsageMonitorEvent {
  const hasCost = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd);
  const isPinecone = entry.provider === "pinecone";
  const quantity = isPinecone
    ? (entry.tokensIn ?? 0)
    : (entry.tokensIn ?? 0) + (entry.tokensOut ?? 0);
  // Voyage embed/rerank quantities are token estimates. Pinecone query/upsert quantities are
  // Read/Write Units in tokensIn, with records kept separately in metadata.
  const unit: UsageUnit = isPinecone ? "credit" : "token";
  return {
    sourceApp: SOURCE_APP,
    environment: usageMonitorEnv(),
    provider: entry.provider,
    service: "rag",
    project: PROJECT,
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
  };
}

export function pushRagUsage(entry: RagUsageMonitorEntry): void {
  if (!usageMonitorEnabled()) return;
  try {
    enqueuePending(ragUsageEvent(entry), "rag", entry.sourceEventId);
  } catch {
    /* telemetry must never break the caller */
  }
}

/** Build the exact deterministic event used to replay one persisted rag_usage row. */
export async function createRagUsageMonitorEvent(
  entry: RagUsageMonitorEntry & { sourceEventId: string; occurredAt: string }
): Promise<UsageMonitorEvent> {
  return {
    ...ragUsageEvent(entry),
    idempotencyKey: await telemetryIdempotencyKey("rag", entry.sourceEventId),
  };
}

/** Build the exact deterministic event for one crash-durable provider dispatch outcome. */
export async function createProviderDispatchUsageMonitorEvent(entry: {
  sourceEventId: string;
  occurredAt: string;
  provider: string;
  operation: string;
  credentialRef: string;
  userId: string;
  outcome: "succeeded" | "failed" | "unknown";
  requests?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
}): Promise<UsageMonitorEvent> {
  // INVARIANT: the ledger lanes (pushLlmUsage/pushRagUsage, service "llm"/"rag") are the single
  // external cost authority for every provider they cover — dispatch (service "provider-dispatch")
  // is a quota/request-volume signal only, for every provider, always. entry.estimatedCostUsd /
  // entry.actualCostUsd above still drive the LOCAL per-credential daily cost-cap fuse
  // (reserveProviderDispatch's maxEstimatedCostUsdPer24h check in db-provider-dispatch.ts) and must
  // stay real there — but they must never be threaded into the event pushed to the monitor below.
  // The monitor's receiver sums cost by provider name only (it ignores `service`), so a non-zero
  // costUsd here would double-count spend the ledger lane already reported for the same call.
  return {
    sourceApp: SOURCE_APP,
    environment: usageMonitorEnv(),
    provider: entry.provider,
    service: "provider-dispatch",
    project: PROJECT,
    label: entry.operation,
    keyRef: entry.credentialRef,
    billingMode: "estimated",
    metricType: "usage",
    unit: "request",
    requests: entry.requests ?? 1,
    confidence: entry.outcome === "unknown" ? "estimated" : "actual",
    occurredAt: entry.occurredAt,
    metadata: cleanMetadata({
      operation: entry.operation,
      userId: entry.userId,
      outcome: entry.outcome,
      unknownOutcome: entry.outcome === "unknown",
    }),
    idempotencyKey: await telemetryIdempotencyKey("provider-dispatch", entry.sourceEventId),
  };
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
    // Number.isFinite (not typeof === "number") at admission: NaN and Infinity are both typeof
    // "number" but the shared UsageTelemetryEvent schema rejects them (.finite()), so a NaN balance
    // would poison the batch. Reject it here so the bad reading never enters the buffer.
    if (Number.isFinite(entry.cash)) {
      enqueuePending({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        project: PROJECT,
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
    if (Number.isFinite(entry.buyingPower)) {
      enqueuePending({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        project: PROJECT,
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
    if (Number.isFinite(entry.equity)) {
      enqueuePending({
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: "broker",
        project: PROJECT,
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
    const existing = state.callVolume.get(key);
    if (!existing) {
      // Bound distinct lanes: callVolume is drained each flush, but while the breaker is open the
      // next flush can be up to breakerMaxMs away, and high-cardinality per-user market-data keys
      // could otherwise accumulate one entry per user for that whole window. Evict oldest-inserted
      // lanes (Map keeps insertion order) to make room — a dropped aggregate is best-effort
      // telemetry, and the durable ledgers don't depend on it.
      const maxKeys = callVolumeMaxKeys();
      while (maxKeys > 0 && state.callVolume.size >= maxKeys) {
        const oldest = state.callVolume.keys().next().value;
        if (oldest === undefined) break;
        state.callVolume.delete(oldest);
      }
    }
    const entry =
      existing ??
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
    receivedAt: Date.now(),
  });
  trimBufferedEvents(Date.now());
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
      receivedAt: Date.now(),
      event: {
        sourceApp: SOURCE_APP,
        environment: usageMonitorEnv(),
        provider: entry.provider,
        service: entry.service,
        project: PROJECT,
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
): Promise<QueuedUsageEvent[]> {
  return Promise.all(
    pending.map(async ({ event, kind, sourceId, receivedAt }) => ({
      event: {
        ...event,
        idempotencyKey: await telemetryIdempotencyKey(kind, sourceId),
      },
      receivedAt,
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

  // Trim by TTL/cap at flush entry, not only on enqueue: an event can age past its TTL while sitting
  // in the buffer with no new telemetry arriving, and must be dropped BEFORE it reaches the send path.
  trimBufferedEvents(Date.now());

  const now = new Date().toISOString();
  const unresolved = state.pendingQueue
    .splice(0, state.pendingQueue.length)
    .concat(drainCallVolume(now));
  let resolved: QueuedUsageEvent[];
  try {
    resolved = await resolvePendingEvents(unresolved);
  } catch {
    // Web Crypto is expected in every supported runtime. If it is temporarily
    // unavailable, retain the original descriptors rather than sending events
    // without their stable delivery identity.
    state.pendingQueue.unshift(...unresolved);
    trimBufferedEvents(Date.now());
    scheduleFlush();
    return;
  }
  const all = state.queue.splice(0, state.queue.length).concat(resolved);
  if (all.length === 0) return;

  // Quarantine schema-invalid (poison) events OUT of the buffer before sending: client.send parses
  // the batch before any fetch, so a poison event's ZodError would otherwise be caught as a delivery
  // failure and falsely trip the breaker — and re-fail on every flush forever. A local bad-data error
  // is not "receiver down". Drop them (best-effort log) and only ever send/re-queue valid events.
  const pending: QueuedUsageEvent[] = [];
  let poisonCount = 0;
  for (const q of all) {
    if (isDeliverableEvent(q.event)) pending.push(q);
    else poisonCount += 1;
  }
  warnPoisonDropped(poisonCount, "live-push");
  if (pending.length === 0) return;

  for (let i = 0; i < pending.length; i += MAX_BATCH) {
    const batch = pending.slice(i, i + MAX_BATCH);
    const sent = await postBatch(batch.map((q) => q.event));
    if (!sent) {
      // Keep the exact event objects — including explicit key + occurredAt —
      // so an ambiguous accepted-then-disconnected response retries safely. Only deliverable events
      // are re-queued (poison was already dropped above), so a bad-data event can't re-fail forever.
      state.queue.unshift(...pending.slice(i));
      trimBufferedEvents(Date.now());
      // While the breaker is open, wait out its window instead of retrying on the short flush
      // cadence — that's the suppression that stops a dead receiver from being hammered.
      const now = Date.now();
      const delay = state.breaker.openUntil > now ? state.breaker.openUntil - now : flushDelayMs();
      scheduleFlush(delay);
      return;
    }
  }
}

/**
 * Record the `usage-monitor` connection result for the admin health page. BOTH the live-push
 * (postBatch) and durable-replay (sendUsageMonitorBatch) lanes call this, so the health row reflects
 * reality no matter which lane actually talked to the monitor. Without this in the replay lane, a
 * replay-first failure would open the shared breaker and then suppress every later postBatch attempt
 * for the whole backoff window — leaving the health row "healthy"/stale even though the monitor is
 * down (the very stale-observability bug this incident was about). `logApiHealth` already swallows
 * its own errors, but keep this best-effort so it can never break a fire-and-forget caller.
 */
function recordUsageMonitorHealth(ok: boolean, startedAt: number, err?: unknown): void {
  try {
    logApiHealth({
      service: HEALTH_SERVICE,
      ok,
      latencyMs: Date.now() - startedAt,
      ...(ok ? {} : { errorText: err instanceof Error ? err.message : String(err) }),
    });
  } catch {
    /* health recording is best-effort; never break the caller/replay path */
  }
}

/**
 * True when an event passes the shared UsageTelemetryEvent schema — i.e. it is safe to hand to
 * `client.send`, which parses the batch BEFORE any fetch. An event that fails here (e.g. a NaN /
 * Infinity `quantity` that slipped past an admission guard) would throw a ZodError before the
 * network is ever touched. That is a LOCAL data bug, not a receiver outage, so we must never let it
 * reach the send path where its throw would be misread as a delivery failure and trip the breaker.
 */
function isDeliverableEvent(event: UsageMonitorEvent): boolean {
  return UsageTelemetryEventSchema.safeParse(event).success;
}

/** Best-effort visibility for dropped poison events; never throws. */
function warnPoisonDropped(count: number, lane: string): void {
  if (count <= 0) return;
  try {
    console.warn(
      `[usage-monitor-push] dropped ${count} schema-invalid telemetry event(s) from ${lane} ` +
        `(local validation failure — not a receiver outage; breaker untouched)`
    );
  } catch {
    /* logging is best-effort */
  }
}

async function postBatch(events: UsageMonitorEvent[]): Promise<boolean> {
  const baseUrl = usageMonitorBaseUrl();
  const token = usageMonitorToken();
  if (events.length === 0) return true;
  if (!baseUrl || !token) return false;
  if (!breakerAllowsAttempt(Date.now())) return false; // circuit open: no network call

  const fetchImpl = state.fetchImpl ?? fetch;
  const start = Date.now();
  // Bound the attempt: a monitor that accepts the connection but never responds would otherwise
  // leave client.send awaiting forever, so the attempt never records a failure and the breaker
  // never trips — the half-up outage. AbortSignal converts that hang into a recorded failure.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pushTimeoutMs());
  try {
    const client = createUsageTelemetryClient({
      baseUrl,
      token,
      fetchImpl: (input, init) => fetchImpl(input, { ...init, signal: controller.signal }),
    });
    await client.send(events);
    recordUsageMonitorHealth(true, start);
    breakerRecordResult(true, Date.now());
    return true;
  } catch (err) {
    recordUsageMonitorHealth(false, start, err);
    breakerRecordResult(false, Date.now());
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Max wall-clock for a single replay POST. Prevents a hung connection from permanently blocking the
 * replay interval (which uses an inFlight promise guard — the promise would never settle otherwise).
 */
const REPLAY_SEND_TIMEOUT_MS = 30_000;

/**
 * Send a caller-owned batch and report whether the monitor acknowledged it. Unlike the live
 * in-memory queue, this does not retain failed events: durable callers keep their ledger cursor
 * unchanged and reconstruct the exact same idempotent payload on the next pass.
 *
 * Applies an AbortSignal timeout so that a connection stall cannot permanently block the caller
 * (the replay worker's inFlight guard is never cleared if the POST promise never settles).
 */
export async function sendUsageMonitorBatch(
  events: UsageMonitorEvent[]
): Promise<boolean> {
  if (events.length === 0) return true;
  if (!usageMonitorEnabled()) return false;

  const baseUrl = usageMonitorBaseUrl();
  const token = usageMonitorToken();
  if (!baseUrl || !token) return false;

  // Drop schema-invalid (poison) events before the breaker check / fetch: client.send validates the
  // batch before any network call, so a poison event is a LOCAL data bug, not a receiver outage —
  // it must not trip the breaker. Reporting the delivery as acknowledged (return true when nothing
  // valid remains) lets the durable caller advance its watermark past the bad row instead of
  // re-failing it forever.
  const deliverable = events.filter(isDeliverableEvent);
  warnPoisonDropped(events.length - deliverable.length, "replay");
  if (deliverable.length === 0) return true;

  // Shares the live-push breaker: the replay interval fires every 60s regardless, but while the
  // circuit is open this returns false immediately with no fetch call, so replay's fixed cadence
  // can't turn into a second continuous hammer on top of the live queue's own backoff.
  if (!breakerAllowsAttempt(Date.now())) return false;

  const fetchImpl = state.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_SEND_TIMEOUT_MS);
  const start = Date.now();

  try {
    const client = createUsageTelemetryClient({
      baseUrl,
      token,
      fetchImpl: (input, init) =>
        fetchImpl(input, { ...init, signal: controller.signal }),
    });
    await client.send(deliverable);
    // Record health from the replay lane too — if replay is the first/only lane talking to a down
    // monitor, this is what keeps the admin health row truthful instead of stale-healthy while the
    // shared breaker (below) suppresses the live-push lane's own health writes.
    recordUsageMonitorHealth(true, start);
    breakerRecordResult(true, Date.now());
    return true;
  } catch (err) {
    recordUsageMonitorHealth(false, start, err);
    breakerRecordResult(false, Date.now());
    return false;
  } finally {
    clearTimeout(timer);
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
  sourceId: string | undefined = randomDeliveryId()
): Promise<string> {
  const normalizedSourceId = sourceId?.trim() || randomDeliveryId();
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
  state.breaker = { consecutiveFailures: 0, openUntil: 0, probing: false };
}

/** Test seam: inspect breaker + buffered-queue state without reaching into globalThis. */
export function __usageMonitorDebugState(): {
  breaker: { consecutiveFailures: number; openUntil: number; probing: boolean };
  queueDepth: number;
  callVolumeKeys: number;
} {
  return {
    breaker: { ...state.breaker },
    queueDepth: state.pendingQueue.length + state.queue.length,
    callVolumeKeys: state.callVolume.size,
  };
}
