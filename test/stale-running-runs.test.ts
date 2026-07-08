import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Focused coverage for the crashed-run stale-row sweep (markStaleRunningRuns) wired into the
// scheduler tick. Verifies: (1) a genuinely stale running row is marked failed and receipts
// exactly one account-scoped `strategy_run_crashed` audit; (2) a fresh running row is left
// alone; (3) re-running the sweep is idempotent and never double-receipts.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stale-runs-${randomUUID()}.db`)}`;
});

const STALE_THRESHOLD_MS = 10 * 60_000;

function crashedReceipts(
  db: typeof import("../src/lib/db"),
  userId: string
): Array<{ connected_account_id: string | null; payload: string }> {
  return db
    .getDb()
    .prepare(
      "SELECT connected_account_id, payload FROM audit_events WHERE kind = 'strategy_run_crashed' AND user_id = ?"
    )
    .all(userId) as Array<{ connected_account_id: string | null; payload: string }>;
}

describe("markStaleRunningRuns", () => {
  it("marks a stale running run failed and writes exactly one account-scoped receipt", async () => {
    const db = await import("../src/lib/db");
    const userId = `stale-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId, accountId);
    // Simulate the tick firing well after the run started (started_at is ~now, so a `now`
    // 20 min in the future puts it past the 10 min stale cutoff).
    const future = Date.now() + 2 * STALE_THRESHOLD_MS;

    expect(db.markStaleRunningRuns(future)).toBe(1);

    const row = db
      .getDb()
      .prepare("SELECT status, summary FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string; summary: string | null };
    expect(row.status).toBe("failed");
    expect(row.summary).toContain("stale-run sweep");

    const receipts = crashedReceipts(db, userId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].connected_account_id).toBe(accountId);
    expect(JSON.parse(receipts[0].payload).runId).toBe(runId);

    // Idempotent: the row is already failed, so a second sweep neither re-counts nor re-receipts.
    expect(db.markStaleRunningRuns(future)).toBe(0);
    expect(crashedReceipts(db, userId)).toHaveLength(1);
  });

  it("leaves a fresh (non-stale) running run untouched", async () => {
    const db = await import("../src/lib/db");
    const userId = `fresh-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    // A sweep evaluated at the present moment: a run started ~now is not yet past the cutoff.
    expect(db.markStaleRunningRuns(Date.now())).toBe(0);

    const row = db
      .getDb()
      .prepare("SELECT status FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(row.status).toBe("running");
    expect(crashedReceipts(db, userId)).toHaveLength(0);
  });
});
