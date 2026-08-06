// task-journal.ts — lane wrapper around the task_journal ledger (db-task-journal.ts).
//
// Wraps a scheduled/background lane so every fire lands in the unified journal with timing
// and outcome. The wrapper adds no behavior to the lane: results pass through, errors
// re-throw to the caller's own handler, and a journaling failure can never break the lane.
import { recordTaskEnd, recordTaskStart } from "./db-task-journal";
import { safeErrorMessage } from "./telemetry-sanitize";

export interface JournalLaneContext {
  userId?: string;
  connectedAccountId?: string;
  metadata?: Record<string, unknown>;
}

export interface JournalLaneOutcome<T> {
  /** 'ok' default; 'skipped' = lane evaluated but had nothing to do (ages out in 24h). */
  status?: "ok" | "skipped";
  summary?: string;
  value?: T;
}

/** Structural guard: only an explicit ok/skipped status (or a `value` key) marks a result as
 *  a JournalLaneOutcome. Lanes whose real return value is an object with its own `status`
 *  field (e.g. { status: "success" }) are therefore NOT mistaken for outcome envelopes. */
function isLaneOutcome<T>(result: unknown): result is JournalLaneOutcome<T> {
  if (result === null || typeof result !== "object") return false;
  const candidate = result as { status?: unknown; value?: unknown };
  return candidate.status === "ok" || candidate.status === "skipped" || "value" in candidate;
}

/**
 * Run `fn` journaled as `taskName`. `fn` may return a bare value or a JournalLaneOutcome
 * ({ status: "ok"|"skipped", summary, value }); the lane's resolved value is returned either
 * way. Errors are journaled as status 'error' and re-thrown so the caller's existing catch
 * behavior is unchanged.
 */
export async function journalLane<T>(
  taskName: string,
  context: JournalLaneContext,
  fn: () => Promise<T | JournalLaneOutcome<T>> | T | JournalLaneOutcome<T>
): Promise<T> {
  const id = recordTaskStart({ taskName, ...context });
  try {
    const result = await fn();
    if (isLaneOutcome<T>(result)) {
      recordTaskEnd(id, { status: result.status ?? "ok", summary: result.summary });
      return result.value as T;
    }
    recordTaskEnd(id, { status: "ok" });
    return result as T;
  } catch (error) {
    recordTaskEnd(id, { status: "error", error: safeErrorMessage(error) });
    throw error;
  }
}
