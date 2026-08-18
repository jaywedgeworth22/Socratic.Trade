import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { opsDiagnosticSecrets } from "../src/lib/ops-auth";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-snapshot-${randomUUID()}.db`)}`;
});

describe("ops auth", () => {
  it("prefers OPS_DIAGNOSTIC_TOKEN exclusively over legacy admin token", () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "ops-only";
    process.env.ADMIN_REINDEX_TOKEN = "legacy-admin";
    expect(opsDiagnosticSecrets()).toEqual(["ops-only"]);
    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    expect(opsDiagnosticSecrets()).toEqual(["legacy-admin"]);
    delete process.env.ADMIN_REINDEX_TOKEN;
    expect(opsDiagnosticSecrets()).toEqual([]);
  });
});

describe("ops diagnostic snapshot", () => {
  it("rejects requests without a token", async () => {
    const { GET } = await import("../app/api/ops/snapshot/route");
    const response = await GET(new Request("http://localhost/api/ops/snapshot"));
    expect(response.status).toBe(401);
  });

  it("returns per-account runs and audit when authorized", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token";
    const db = await import("../src/lib/db");
    const userId = `ops-user-${randomUUID()}`;
    const paperId = `paper-${randomUUID()}`;
    const rothId = `roth-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: paperId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PAPER-1",
      label: "Alpaca Paper",
      isActive: true
    });
    db.upsertConnectedAccount({
      id: rothId,
      userId,
      broker: "alpaca",
      environment: "live",
      accountNumber: "ROTH-2",
      label: "Roth IRA",
      isActive: false
    });
    const stateBefore = db.getDb()
      .prepare("SELECT COUNT(*) AS c FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
      .get(userId, rothId) as { c: number };
    expect(stateBefore.c).toBe(0);

    db.setPolicy({ ...db.getPolicy(userId, paperId), systemState: "active", strategyAuthority: "decide", llmModel: "gpt-5.4-mini" }, userId, paperId);

    const runId = randomUUID();
    db.insertStrategyRun(runId, userId, rothId);
    db.finishStrategyRun(runId, "failed", "Selected account is not available.", userId);
    db.audit(
      "strategy_run",
      { runId, status: "failed", summary: "Selected account is not available.", proposals: [] },
      userId,
      rothId
    );
    db.insertProposal({
      id: randomUUID(),
      userId,
      runId,
      accountNumber: "ROTH-2",
      proposal: {
        symbol: "EXE",
        side: "buy",
        type: "market",
        dollarAmount: 4,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "Ops snapshot filled-state regression.",
        tradeThesisTag: "Value-Quality",
        entryMarketRegime: "Neutral"
      },
      decision: { approved: true, reasons: [] },
      estimatedNotional: 4,
      status: "filled",
      executionMode: "broker/live"
    });

    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 5, auditPerUser: 5 });
    const stateAfter = db.getDb()
      .prepare("SELECT COUNT(*) AS c FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
      .get(userId, rothId) as { c: number };
    expect(stateAfter.c).toBe(0);
    const user = snapshot.users.find((row) => row.userId === userId);
    expect(user).toBeDefined();
    expect(user!.accounts).toHaveLength(2);
    expect(user!.accounts.find((a) => a.connectedAccountId === rothId)?.label).toBe("Roth IRA");
    const roth = user!.accounts.find((a) => a.connectedAccountId === rothId);
    expect(roth?.authorityLabel === "Autopilot" || roth?.authorityLabel === "Ask-first").toBe(true);
    expect(roth?.runStateLabel).toBeTruthy();
    expect(user!.recentRuns.some((r) => r.connectedAccountId === rothId && r.summary?.includes("not available"))).toBe(true);
    expect(user!.recentRuns.find((r) => r.id === runId)?.placedCount).toBe(1);
    expect(user!.recentAudit.some((a) => a.kind === "strategy_run" && a.accountLabel === "Roth IRA")).toBe(true);

    const { GET } = await import("../app/api/ops/snapshot/route");
    const response = await GET(
      new Request("http://localhost/api/ops/snapshot", {
        headers: { "x-ops-token": "test-ops-token" }
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.users.some((u: { userId: string }) => u.userId === userId)).toBe(true);
    expect(body.roicArchive).toBeTruthy();
    expect(typeof body.roicArchive.transcriptsWithContent).toBe("number");

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
  });

  // Root-cause: today's prod broker-rejection triage was blocked because this kind wasn't in
  // the ops-snapshot audit allowlist — the raw rejection body (audit()'s `reason` field, the
  // actual broker error text) never reached remote diagnostics. See OPS_AUDIT_KINDS in
  // src/lib/ops-snapshot.ts.
  it("surfaces order_rejected_by_broker audit rows (including the raw broker rejection reason) in recentAudit", async () => {
    const db = await import("../src/lib/db");
    const userId = `ops-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "live",
      accountNumber: "REJ-1",
      label: "Rejection Test",
      isActive: true
    });

    const runId = randomUUID();
    const proposalId = randomUUID();
    db.audit(
      "order_rejected_by_broker",
      { runId, proposalId, symbol: "AAPL", side: "buy", reason: "insufficient buying power" },
      userId,
      accountId
    );

    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 5, auditPerUser: 5 });
    const user = snapshot.users.find((row) => row.userId === userId);
    expect(user).toBeDefined();
    const rejection = user!.recentAudit.find((a) => a.kind === "order_rejected_by_broker");
    expect(rejection).toBeDefined();
    expect(rejection!.detail).toContain("insufficient buying power");
    expect(rejection!.detail).toContain("symbol=AAPL");
  });

  it("omits retired FilingAPI leftover failures and treats expected-limit lanes as ok", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "filingapi", ok: false, errorText: "HTTP 401 Unauthorized", keySource: "env" });
    }
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "vix-yahoo", ok: false, errorText: "HTTP 429", soft: true, keySource: "none" });
    }
    logApiHealth({ service: "roic", ok: true, latencyMs: 12, keySource: "env" });

    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    const deps = snapshot.dependencies ?? {};
    expect(deps.filingapi).toBeUndefined();
    expect(deps["vix-yahoo"]?.ok).toBe(true);
    expect(deps.roic?.ok).toBe(true);
  });

  it("summarizeBrokerOrderList separates live working from historical done_for_day", async () => {
    const { summarizeBrokerOrderList } = await import("../src/lib/ops-snapshot");
    const summary = summarizeBrokerOrderList([
      { id: "1", symbol: "AAPL", side: "buy", type: "limit", state: "new", createdAt: "2026-07-27T12:00:00.000Z" },
      { id: "2", symbol: "T", side: "sell", type: "limit", state: "held", createdAt: "2026-07-27T12:00:00.000Z" },
      { id: "3", symbol: "OLD", side: "buy", type: "limit", state: "done_for_day", createdAt: "2026-05-01T12:00:00.000Z" },
      { id: "4", symbol: "OLD2", side: "buy", type: "market", state: "done_for_day", createdAt: "2026-04-01T12:00:00.000Z" },
      { id: "5", symbol: "X", side: "buy", type: "market", state: "filled", createdAt: "2026-07-20T12:00:00.000Z" }
    ]);
    expect(summary.listedCount).toBe(5);
    expect(summary.liveCount).toBe(2);
    expect(summary.workingCount).toBe(2);
    expect(summary.doneForDayCount).toBe(2);
    expect(summary.topStates.find((s) => s.state === "done_for_day")?.count).toBe(2);
  });

  it("exposes the Pinecone trial window and does not paint soft 429 backups as down", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
    const db = await import("../src/lib/db");
    db.getDb();
    const { logApiHealth } = await import("../src/lib/db-health");
    logApiHealth({ service: "vix-cboe", ok: true, latencyMs: 20 });
    logApiHealth({
      service: "vix-yahoo",
      ok: false,
      latencyMs: 15,
      errorText: "[expected-limit] HTTP 429",
      soft: true
    });
    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    expect(snapshot.pineconeIngest).toBeDefined();
    expect(snapshot.pineconeIngest!.trial.active).toBe(true);
    expect(snapshot.pineconeIngest!.trial.effectiveDailyWriteUnits).toBeGreaterThanOrEqual(2_048);
    expect(snapshot.pineconeIngest!.trial.effectiveTextsPerDay).toBeGreaterThanOrEqual(32);
    expect(snapshot.dependencies?.["vix-cboe"]?.ok).toBe(true);
    expect(snapshot.dependencies?.["vix-yahoo"]?.ok).toBe(true);
  });
});
