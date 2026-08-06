/**
 * Per-run RAG budget ceiling with graceful degradation (R16, 2026-07-01 RAG backlog).
 *
 * Rerank is on by default and the strategy scan fans out per candidate symbol; on a large
 * universe (especially with a paid Voyage key and VECTOR_EMBED_BATCH_DELAY_MS=0) this is an
 * effectively unbounded embed+rerank+query volume per process. This module implements a
 * default-off, VERY-HIGH-ceiling rolling-window counter of retrieval "operations" (embed/rerank
 * calls tallied via `recordRagOperation`). Deliberately process-global (not threaded through
 * every call signature via a `runId`) — a per-run accounting scheme is a natural follow-up once
 * R5 telemetry shows a real, specific cost problem worth the wiring cost.
 *
 * On trip: the budget ceiling DEGRADES retrieval by skipping rerank/hybrid ONLY (both stages the
 * pipeline already treats as optional/fail-open-capable) — it NEVER blocks core dense-cosine
 * recall, and emits exactly one audit row per trip (not one per call, which would itself be a
 * cost/log-volume problem under sustained load).
 *
 * Default OFF via RAG_RUN_BUDGET_ENABLED — when off, `shouldDegradeForBudget()` always returns
 * false and `recordRagOperation()` is a no-op, so default retrieval is completely unaffected.
 */

import { audit } from "../db";
import { envFlagOn } from "./env-flag";

const DEFAULT_CEILING = 5000; // "very high" — many multiples of a normal single-user session's call volume
const DEFAULT_WINDOW_MS = 60 * 60_000; // 1 hour rolling window

/** Returns true when RAG_RUN_BUDGET_ENABLED is truthy. Default ON (owner enablement 2026-07-24). */
export function runBudgetEnabled(): boolean {
  return envFlagOn("RAG_RUN_BUDGET_ENABLED", true);
}

function ceiling(): number {
  const parsed = Number(process.env.RAG_RUN_BUDGET_CEILING ?? DEFAULT_CEILING);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CEILING;
}

function windowMs(): number {
  const parsed = Number(process.env.RAG_RUN_BUDGET_WINDOW_MS ?? DEFAULT_WINDOW_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_MS;
}

// Rolling-window operation timestamps. Process-global by design (see module doc).
let opTimestamps: number[] = [];
let hasAuditedTrip = false;

/** Prune timestamps outside the current rolling window. */
function pruneWindow(now: number): void {
  const cutoff = now - windowMs();
  if (opTimestamps.length === 0 || opTimestamps[0]! >= cutoff) return;
  opTimestamps = opTimestamps.filter((t) => t >= cutoff);
}

/**
 * Record one RAG "operation" (an embed or rerank call) against the rolling-window counter.
 * No-op when RAG_RUN_BUDGET_ENABLED is off — the counter never grows when disabled.
 */
export function recordRagOperation(now: number = Date.now()): void {
  if (!runBudgetEnabled()) return;
  pruneWindow(now);
  opTimestamps.push(now);
}

/**
 * Returns true when the rolling-window operation count is AT/OVER the ceiling — the caller
 * (retrieveContextDetailed) should then DEGRADE by skipping rerank/hybrid only, never core
 * recall. Emits exactly one `rag_run_budget_tripped` audit row the FIRST time the ceiling is
 * crossed per process lifetime (not once per call) — best-effort, never throws.
 */
export function shouldDegradeForBudget(now: number = Date.now()): boolean {
  if (!runBudgetEnabled()) return false;
  pruneWindow(now);
  const tripped = opTimestamps.length >= ceiling();
  if (tripped && !hasAuditedTrip) {
    hasAuditedTrip = true;
    try {
      audit("rag_run_budget_tripped", { ceiling: ceiling(), windowMs: windowMs(), count: opTimestamps.length }, "local");
    } catch {
      // best-effort telemetry only
    }
  }
  return tripped;
}

/** Test-only: reset the rolling-window state so tests don't leak counters across cases/files. */
export function resetRunBudget(): void {
  opTimestamps = [];
  hasAuditedTrip = false;
}
