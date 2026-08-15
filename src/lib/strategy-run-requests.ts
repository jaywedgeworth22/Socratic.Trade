import { randomUUID } from "crypto";
import { getDb } from "./db";
import { runStrategyOnce, type StrategyResult } from "./strategy";

export type StrategyRunRequestStatus = "queued" | "running" | "completed" | "failed";

export type StrategyRunRequest = {
  id: string;
  userId: string;
  manual: boolean;
  status: StrategyRunRequestStatus;
  result: StrategyResult | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type QueueResult = { request: StrategyRunRequest; deduped: boolean };

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRequest(row: {
  id: string;
  user_id: string;
  manual: number;
  status: StrategyRunRequestStatus;
  result: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}): StrategyRunRequest {
  return {
    id: row.id,
    userId: row.user_id,
    manual: row.manual === 1,
    status: row.status,
    result: row.result ? (JSON.parse(row.result) as StrategyResult) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export function getStrategyRunRequest(runId: string, userId: string): StrategyRunRequest | null {
  const row = getDb()
    .prepare(
      `SELECT id, user_id, manual, status, result, created_at, started_at, finished_at
       FROM strategy_run_requests
       WHERE id = ? AND user_id = ?`
    )
    .get(runId, userId) as
    | {
        id: string;
        user_id: string;
        manual: number;
        status: StrategyRunRequestStatus;
        result: string | null;
        created_at: string;
        started_at: string | null;
        finished_at: string | null;
      }
    | undefined;
  return row ? rowToRequest(row) : null;
}

export function queueStrategyRunRequest(input: { userId: string; manual?: boolean }): QueueResult {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, user_id, manual, status, result, created_at, started_at, finished_at
       FROM strategy_run_requests
       WHERE user_id = ? AND status IN ('queued', 'running')
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(input.userId) as
    | {
        id: string;
        user_id: string;
        manual: number;
        status: StrategyRunRequestStatus;
        result: string | null;
        created_at: string;
        started_at: string | null;
        finished_at: string | null;
      }
    | undefined;
  if (existing) {
    return { request: rowToRequest(existing), deduped: true };
  }
  const createdAt = nowIso();
  const request: StrategyRunRequest = {
    id: randomUUID(),
    userId: input.userId,
    manual: input.manual === true,
    status: "queued",
    result: null,
    createdAt,
    startedAt: null,
    finishedAt: null
  };
  db.prepare(
    `INSERT INTO strategy_run_requests
      (id, user_id, manual, status, result, created_at, started_at, finished_at)
     VALUES (?, ?, ?, 'queued', NULL, ?, NULL, NULL)`
  ).run(request.id, request.userId, request.manual ? 1 : 0, request.createdAt);
  return { request, deduped: false };
}

export async function processPendingStrategyRunRequests(
  options: { limit?: number } = {}
): Promise<{ processed: number }> {
  const limit = Math.max(1, options.limit ?? 1);
  const db = getDb();
  const claimed = db
    .prepare(
      `SELECT id, user_id, manual
       FROM strategy_run_requests
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as Array<{ id: string; user_id: string; manual: number }>;

  let processed = 0;
  for (const row of claimed) {
    const startedAt = nowIso();
    const claim = db
      .prepare(
        `UPDATE strategy_run_requests
         SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'queued'`
      )
      .run(startedAt, row.id);
    if (claim.changes !== 1) continue;

    try {
      const result = await runStrategyOnce(row.user_id, {
        manual: row.manual === 1,
        runId: row.id
      });
      db.prepare(
        `UPDATE strategy_run_requests
         SET status = ?, result = ?, finished_at = ?
         WHERE id = ?`
      ).run(result.status === "failed" ? "failed" : "completed", JSON.stringify(result), nowIso(), row.id);
    } catch (error) {
      const failed: StrategyResult = {
        runId: row.id,
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        proposals: []
      };
      db.prepare(
        `UPDATE strategy_run_requests
         SET status = 'failed', result = ?, finished_at = ?
         WHERE id = ?`
      ).run(JSON.stringify(failed), nowIso(), row.id);
    }
    processed += 1;
  }
  return { processed };
}
