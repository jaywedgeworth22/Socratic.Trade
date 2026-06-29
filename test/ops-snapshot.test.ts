import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-snapshot-${randomUUID()}.db`)}`;
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
    db.setPolicy({ ...db.getPolicy(userId, paperId), systemState: "active", strategyAuthority: "decide", llmModel: "gpt-5.4-mini" }, userId, paperId);
    db.setPolicy({ ...db.getPolicy(userId, rothId), systemState: "active", strategyAuthority: "decide", llmModel: "gemini-2.5-flash" }, userId, rothId);

    const runId = randomUUID();
    db.insertStrategyRun(runId, userId, rothId);
    db.finishStrategyRun(runId, "failed", "Selected account is not available.", userId);
    db.audit(
      "strategy_run",
      { runId, status: "failed", summary: "Selected account is not available.", proposals: [] },
      userId,
      rothId
    );

    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 5, auditPerUser: 5 });
    const user = snapshot.users.find((row) => row.userId === userId);
    expect(user).toBeDefined();
    expect(user!.accounts).toHaveLength(2);
    expect(user!.accounts.find((a) => a.connectedAccountId === rothId)?.llmModel).toBe("gemini-2.5-flash");
    expect(user!.recentRuns.some((r) => r.connectedAccountId === rothId && r.summary?.includes("not available"))).toBe(true);
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

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
  });
});
