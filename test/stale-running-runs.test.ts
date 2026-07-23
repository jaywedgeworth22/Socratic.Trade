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

const STALE_THRESHOLD_MS = 30 * 60_000; // matches db-execution.ts's STALE_RUN_THRESHOLD_MS

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

  // 2026-07-08 incident regression: a live evening run (LLM steps 150s+ each) was marked "crashed"
  // by this sweep at the ~11-minute mark under the old 10-min threshold and completed 5s later,
  // having already placed 4 real trades. Beyond the raised 30-min threshold, a run that's still
  // emitting audit activity (any row carrying its runId, timestamped inside the sweep's lookback
  // window) is demonstrably still alive — just slow — and must be left alone.
  it("leaves a time-stale running run alone when it has recent audit activity (still alive, just slow)", async () => {
    const db = await import("../src/lib/db");
    const userId = `heartbeat-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    // Evaluate the sweep well past the 30-min cutoff relative to the run's real (~now) started_at.
    const future = Date.now() + 2 * STALE_THRESHOLD_MS;

    // Simulate the run still being alive: an audit row carrying this runId, timestamped just before
    // the sweep's evaluation instant — well inside the [future - threshold, future] lookback window.
    db.getDb()
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, NULL, ?, ?, ?)"
      )
      .run(randomUUID(), userId, new Date(future - 1000).toISOString(), "llm_step", JSON.stringify({ runId, step: "bull" }));

    // NOTE: don't assert on markStaleRunningRuns' raw return value here — this file shares one DB
    // across `it` blocks, and an earlier test's leftover `running` row (e.g. the "fresh" test above,
    // whose row is still real-time-fresh at ITS OWN evaluation but is old enough to be swept by
    // THIS test's synthetic far-future `now`) can also legitimately get marked failed in the same
    // sweep, inflating the count. Scope the assertion to this test's own run/user instead.
    db.markStaleRunningRuns(future);

    const row = db
      .getDb()
      .prepare("SELECT status FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(row.status).toBe("running");
    expect(crashedReceipts(db, userId)).toHaveLength(0);
  });

  it("still marks a time-stale running run failed when it has NO recent audit activity", async () => {
    const db = await import("../src/lib/db");
    const userId = `no-heartbeat-user-${randomUUID()}`;
    const runId = randomUUID();

    db.insertStrategyRun(runId, userId);
    const future = Date.now() + 2 * STALE_THRESHOLD_MS;

    // An audit row exists for this run, but it's OLDER than the lookback window (simulating stale
    // history from long before the crash) — it must not grant grace.
    db.getDb()
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, NULL, ?, ?, ?)"
      )
      .run(randomUUID(), userId, new Date(0).toISOString(), "llm_step", JSON.stringify({ runId, step: "bull" }));

    // See the note in the previous test — scope to this run/user rather than the global count.
    db.markStaleRunningRuns(future);

    const row = db
      .getDb()
      .prepare("SELECT status FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(row.status).toBe("failed");
    expect(crashedReceipts(db, userId)).toHaveLength(1);
  });
});
