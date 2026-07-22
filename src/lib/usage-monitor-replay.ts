// Crash-durable replay of Socratic.Trade's local usage ledgers into API Usage Monitor.
//
// Live writes still enqueue immediately through usage-monitor-push.ts. This worker closes the
// durability gap left by a process crash: it reconstructs events from llm_usage / rag_usage using
// each row's existing ID + timestamp, and advances an ordered settings-table watermark only after
// the monitor acknowledges the batch. Every run inclusively re-sends the prior watermark row, so
// a crash between remote acknowledgement and the local watermark write is harmless (the receiver
// dedupes the deterministic idempotency key).

import {
  getDb,
  listProviderUsageOutboxRows,
  reconcileStaleProviderDispatches,
  type ProviderUsageOutboxRow,
} from "./db";
import {
  createLlmUsageMonitorEvent,
  createProviderDispatchUsageMonitorEvent,
  createRagUsageMonitorEvent,
  sendLegacyUsageMonitorBatch,
  sendUsageMonitorBatch,
  usageMonitorEnabled,
  type UsageMonitorEvent,
} from "./usage-monitor-push";

const REPLAY_INTERVAL_MS = 60_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES_PER_LEDGER = 10;

export const USAGE_MONITOR_REPLAY_WATERMARK_KEYS = {
  llm: "usage_monitor_replay:llm_usage:watermark:v1",
  rag: "usage_monitor_replay:rag_usage:watermark:v1",
  provider: "usage_monitor_replay:provider_usage_outbox:watermark:v1",
} as const;

export const USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS = {
  llm: "usage_monitor_replay:llm_usage:strict_v2_cutover:v1",
  rag: "usage_monitor_replay:rag_usage:strict_v2_cutover:v1",
  provider: "usage_monitor_replay:provider_usage_outbox:strict_v2_cutover:v1",
} as const;

interface ReplayCursor {
  createdAt: string;
  id: string;
}

interface LlmUsageLedgerRow {
  id: string;
  user_id: string;
  provider: string;
  model: string | null;
  context: string;
  key_source: string;
  key_ref: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

interface RagUsageLedgerRow {
  id: string;
  user_id: string;
  operation: string;
  provider: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  batch_count: number | null;
  cost_est_usd: number | null;
  created_at: string;
}

interface LedgerReplayResult {
  sent: number;
  complete: boolean;
  failed: boolean;
}

export interface UsageMonitorReplayResult {
  configured: boolean;
  llm: LedgerReplayResult;
  rag: LedgerReplayResult;
  provider: LedgerReplayResult;
}

export interface UsageMonitorReplayOptions {
  /** Test/maintenance override; production uses the ingest contract's 100-event maximum. */
  pageSize?: number;
  /** Bounds one startup/interval pass so a large historical ledger drains without a request burst. */
  maxPagesPerLedger?: number;
}

interface ReplayState {
  version: number;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<UsageMonitorReplayResult> | null;
}

const replayHost = globalThis as unknown as { __usageMonitorReplay?: ReplayState };
// Bump when replay lanes change so HMR cannot leave an older timer running without the provider
// outbox lane added by the durable-dispatch migration.
const REPLAY_STATE_VERSION = 2;
const priorReplayState = replayHost.__usageMonitorReplay;
if (priorReplayState && priorReplayState.version !== REPLAY_STATE_VERSION && priorReplayState.timer) {
  clearInterval(priorReplayState.timer);
}
const replayState: ReplayState =
  priorReplayState && priorReplayState.version === REPLAY_STATE_VERSION
    ? priorReplayState
    : (replayHost.__usageMonitorReplay = {
        version: REPLAY_STATE_VERSION,
        timer: null,
        inFlight: null,
      });

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, maximum);
}

function emptyLedgerResult(): LedgerReplayResult {
  return { sent: 0, complete: true, failed: false };
}

function parseCursor(raw: string | undefined): ReplayCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReplayCursor>;
    if (
      typeof parsed.createdAt !== "string" || parsed.createdAt.length === 0 ||
      typeof parsed.id !== "string" || parsed.id.length === 0
    ) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function compareCursors(a: ReplayCursor, b: ReplayCursor): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function readWatermark(key: string): ReplayCursor | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return parseCursor(row?.value);
}

function hasCompletedV2Cutover(key: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM settings WHERE key = ?").get(key));
}

/** Mark the v2 identity cutover only after the bounded legacy catch-up is fully acknowledged. */
function completeV2Cutover(key: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, 'complete', ?)"
    )
    .run(key, now);
}

/** Monotonic BEGIN IMMEDIATE update prevents overlapping app processes from regressing a cursor. */
function advanceWatermark(
  key: string,
  v2CutoverKey: string,
  candidate: ReplayCursor,
  markCutover = true
): ReplayCursor {
  const database = getDb();
  const advance = database.transaction((): ReplayCursor => {
    const row = database
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    const current = parseCursor(row?.value);
    if (current && compareCursors(current, candidate) >= 0) return current;

    const now = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(key, JSON.stringify(candidate), now);
    if (markCutover) {
      database
        .prepare(
          "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, 'complete', ?)"
        )
        .run(v2CutoverKey, now);
    }
    return candidate;
  });
  return advance.immediate() as ReplayCursor;
}

function cursorClause(inclusive: boolean): string {
  return inclusive
    ? "created_at > ? OR (created_at = ? AND id >= ?)"
    : "created_at > ? OR (created_at = ? AND id > ?)";
}

function upperBoundClause(): string {
  return "created_at < ? OR (created_at = ? AND id <= ?)";
}

function latestCursor(table: string): ReplayCursor | null {
  const row = getDb()
    .prepare(
      `SELECT id, created_at AS createdAt FROM ${table} ` +
        "ORDER BY created_at DESC, id DESC LIMIT 1"
    )
    .get() as ReplayCursor | undefined;
  return row ?? null;
}

function readLlmRows(
  cursor: ReplayCursor | null,
  inclusive: boolean,
  limit: number,
  upperBound: ReplayCursor | null = null
): LlmUsageLedgerRow[] {
  const columns =
    "id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, " +
    "completion_tokens, total_tokens, cost_usd, created_at";
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (cursor) {
    clauses.push(`(${cursorClause(inclusive)})`);
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  if (upperBound) {
    clauses.push(`(${upperBoundClause()})`);
    params.push(upperBound.createdAt, upperBound.createdAt, upperBound.id);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT ${columns} FROM llm_usage${where} ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(...params, limit) as LlmUsageLedgerRow[];
}

function readRagRows(
  cursor: ReplayCursor | null,
  inclusive: boolean,
  limit: number,
  upperBound: ReplayCursor | null = null
): RagUsageLedgerRow[] {
  const columns =
    "id, user_id, operation, provider, model, tokens_in, tokens_out, batch_count, " +
    "cost_est_usd, created_at";
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (cursor) {
    clauses.push(`(${cursorClause(inclusive)})`);
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  if (upperBound) {
    clauses.push(`(${upperBoundClause()})`);
    params.push(upperBound.createdAt, upperBound.createdAt, upperBound.id);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT ${columns} FROM rag_usage${where} ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(...params, limit) as RagUsageLedgerRow[];
}

function optionalFinite(value: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function llmEvents(rows: LlmUsageLedgerRow[]): Promise<UsageMonitorEvent[]> {
  return Promise.all(
    rows.map((row) =>
      createLlmUsageMonitorEvent({
        sourceEventId: row.id,
        occurredAt: row.created_at,
        provider: row.provider,
        model: row.model ?? undefined,
        context: row.context,
        userId: row.user_id,
        keySource: row.key_source,
        keyRef: row.key_ref ?? undefined,
        promptTokens: optionalFinite(row.prompt_tokens),
        completionTokens: optionalFinite(row.completion_tokens),
        totalTokens: optionalFinite(row.total_tokens),
        costUsd: optionalFinite(row.cost_usd),
      })
    )
  );
}

async function ragEvents(rows: RagUsageLedgerRow[]): Promise<UsageMonitorEvent[]> {
  return Promise.all(
    rows.map((row) =>
      createRagUsageMonitorEvent({
        sourceEventId: row.id,
        occurredAt: row.created_at,
        provider: row.provider,
        operation: row.operation,
        model: row.model ?? undefined,
        userId: row.user_id,
        tokensIn: optionalFinite(row.tokens_in),
        tokensOut: optionalFinite(row.tokens_out),
        batchCount: optionalFinite(row.batch_count),
        costUsd: optionalFinite(row.cost_est_usd),
      })
    )
  );
}

function readProviderRows(
  cursor: ReplayCursor | null,
  inclusive: boolean,
  limit: number,
  upperBound: ReplayCursor | null = null
): ProviderUsageOutboxRow[] {
  const rows = listProviderUsageOutboxRows({ after: cursor, inclusive, limit });
  return upperBound
    ? rows.filter((row) => compareCursors({ createdAt: row.created_at, id: row.id }, upperBound) <= 0)
    : rows;
}

async function providerEvents(rows: ProviderUsageOutboxRow[]): Promise<UsageMonitorEvent[]> {
  return Promise.all(rows.map((row) => createProviderDispatchUsageMonitorEvent({
    sourceEventId: row.id,
    occurredAt: row.occurred_at,
    provider: row.provider,
    operation: row.operation,
    credentialRef: row.credential_ref,
    userId: row.user_id,
    outcome: row.outcome,
    requests: row.requests,
    estimatedCostUsd: row.estimated_cost_usd,
    ...(row.actual_cost_usd == null ? {} : { actualCostUsd: row.actual_cost_usd }),
  })));
}

async function replayLedger<Row extends { id: string; created_at: string }>(input: {
  watermarkKey: string;
  v2CutoverKey: string;
  pageSize: number;
  maxPages: number;
  readRows: (
    cursor: ReplayCursor | null,
    inclusive: boolean,
    limit: number,
    upperBound?: ReplayCursor | null
  ) => Row[];
  readHighWatermark: () => ReplayCursor | null;
  toEvents: (rows: Row[]) => Promise<UsageMonitorEvent[]>;
}): Promise<LedgerReplayResult> {
  let sent = 0;
  try {
    let cursor = readWatermark(input.watermarkKey);
    const cutoverComplete = hasCompletedV2Cutover(input.v2CutoverKey);
    // A pre-v2 cursor does not include rows that were live-pushed after the last replay pass.
    // Freeze a high-water mark and drain that bounded window through the legacy idempotency path
    // before switching the ledger to strict v2 identities; rows arriving after the mark are left
    // for the normal v2 pass and can never be double-counted by the cutover.
    const legacyHighWatermark = cutoverComplete ? null : input.readHighWatermark();
    const legacyCatchup = !cutoverComplete && legacyHighWatermark !== null;
    // Legacy replay may safely include the boundary because its durable v1 identity is exactly the
    // key the receiver already deduped. Once cutover is complete, the same overlap uses strict-v2
    // event IDs and remains crash-safe as before.
    let inclusive = cursor !== null;

    for (let page = 0; page < input.maxPages; page += 1) {
      const rows = input.readRows(
        cursor,
        inclusive,
        input.pageSize,
        legacyCatchup ? legacyHighWatermark : null
      );
      inclusive = false;
      if (rows.length === 0) {
        if (!cutoverComplete) completeV2Cutover(input.v2CutoverKey);
        return { sent, complete: true, failed: false };
      }

      const events = await input.toEvents(rows);
      const acknowledged = legacyCatchup
        ? await sendLegacyUsageMonitorBatch(events)
        : await sendUsageMonitorBatch(events);
      if (!acknowledged) {
        return { sent, complete: false, failed: true };
      }

      const last = rows.at(-1)!;
      cursor = advanceWatermark(input.watermarkKey, input.v2CutoverKey, {
        createdAt: last.created_at,
        id: last.id,
      }, !legacyCatchup);
      sent += rows.length;

      if (rows.length < input.pageSize) {
        if (!cutoverComplete) completeV2Cutover(input.v2CutoverKey);
        return { sent, complete: true, failed: false };
      }
    }
    if (legacyCatchup && cursor && legacyHighWatermark && compareCursors(cursor, legacyHighWatermark) >= 0) {
      completeV2Cutover(input.v2CutoverKey);
    }
    return { sent, complete: false, failed: false };
  } catch {
    // Replay is maintenance telemetry: a DB/crypto/network failure must never fail app startup.
    return { sent, complete: false, failed: true };
  }
}

async function executeUsageMonitorReplay(
  options: UsageMonitorReplayOptions
): Promise<UsageMonitorReplayResult> {
  if (!usageMonitorEnabled()) {
    return {
      configured: false,
      llm: emptyLedgerResult(),
      rag: emptyLedgerResult(),
      provider: emptyLedgerResult(),
    };
  }

  // A prior process may have died after dispatch but before observing the provider outcome. Keep
  // the call in usage truth as `unknown`; never guess success/failure or silently release quota.
  reconcileStaleProviderDispatches();

  const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const maxPages = positiveInteger(options.maxPagesPerLedger, DEFAULT_MAX_PAGES_PER_LEDGER, 1_000);
  const llm = await replayLedger<LlmUsageLedgerRow>({
    watermarkKey: USAGE_MONITOR_REPLAY_WATERMARK_KEYS.llm,
    v2CutoverKey: USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.llm,
    pageSize,
    maxPages,
    readRows: readLlmRows,
    readHighWatermark: () => latestCursor("llm_usage"),
    toEvents: llmEvents,
  });
  const rag = await replayLedger<RagUsageLedgerRow>({
    watermarkKey: USAGE_MONITOR_REPLAY_WATERMARK_KEYS.rag,
    v2CutoverKey: USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.rag,
    pageSize,
    maxPages,
    readRows: readRagRows,
    readHighWatermark: () => latestCursor("rag_usage"),
    toEvents: ragEvents,
  });
  const provider = await replayLedger<ProviderUsageOutboxRow>({
    watermarkKey: USAGE_MONITOR_REPLAY_WATERMARK_KEYS.provider,
    v2CutoverKey: USAGE_MONITOR_REPLAY_V2_CUTOVER_KEYS.provider,
    pageSize,
    maxPages,
    readRows: readProviderRows,
    readHighWatermark: () => latestCursor("provider_usage_outbox"),
    toEvents: providerEvents,
  });
  return { configured: true, llm, rag, provider };
}

/** Run one bounded replay pass. Concurrent callers share the same in-process promise. */
export function runUsageMonitorReplay(
  options: UsageMonitorReplayOptions = {}
): Promise<UsageMonitorReplayResult> {
  if (replayState.inFlight) return replayState.inFlight;
  const task = executeUsageMonitorReplay(options);
  replayState.inFlight = task;
  void task.then(
    () => {
      if (replayState.inFlight === task) replayState.inFlight = null;
    },
    () => {
      if (replayState.inFlight === task) replayState.inFlight = null;
    }
  );
  return task;
}

/** Start an immediate pass plus a one-minute unref'd maintenance interval. */
export function startUsageMonitorReplay(): void {
  if (!usageMonitorEnabled() || replayState.timer) return;
  void runUsageMonitorReplay();
  const timer = setInterval(() => {
    void runUsageMonitorReplay();
  }, REPLAY_INTERVAL_MS);
  timer.unref?.();
  replayState.timer = timer;
}

/** Test seam: stop the interval after any awaited replay pass. */
export function __resetUsageMonitorReplayState(): void {
  if (replayState.timer) clearInterval(replayState.timer);
  replayState.timer = null;
  replayState.inFlight = null;
}
