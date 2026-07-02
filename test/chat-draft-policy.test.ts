import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-chat-draft-policy-${randomUUID()}.db`)}`;
});

describe("chat draft policy bridge", () => {
  it("does not stage a draft order when the policy preview is blocked", async () => {
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const { getPolicy, listPendingProposals, setPolicy } = await import("../src/lib/db");
    const { POST } = await import("../app/api/proposals/from-draft/route");

    setPolicy(
      {
        ...getPolicy(DEFAULT_REQUEST_USER_ID),
        systemState: "active",
        accountNumber: "TEST",
        activeBroker: "test",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        maxOrderNotional: 4.99,
        maxOrderPctOfNav: undefined,
        maxDailyNotional: 100
      },
      DEFAULT_REQUEST_USER_ID
    );

    const response = await POST(
      new Request("http://localhost/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: {
            draft_id: "draft-aapl-over-policy",
            symbol: "AAPL",
            side: "buy",
            qty: 1,
            order_type: "market",
            limit_usd: null,
            rationale: "test",
            account_label: "Test",
            is_real: false,
            blocked: false,
            warnings: [],
            executed: false
          }
        })
      })
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("POLICY_BLOCKED");
    expect(body.reasons.join(" ")).toContain("exceeds the maximum order limit");
    expect(listPendingProposals("TEST", DEFAULT_REQUEST_USER_ID)).toHaveLength(0);
  });

  it("stages a draft blocked ONLY by preview staleness (approval-time gate re-checks fresh data)", async () => {
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const { getPolicy, listPendingProposals, setPolicy } = await import("../src/lib/db");
    const { POST } = await import("../app/api/proposals/from-draft/route");

    // Staleness gate ON but caps generous: the scan-less preview treats the missing quote timestamp
    // as stale, so the only block reason is staleness_gate — which must NOT reject the draft here.
    setPolicy(
      {
        ...getPolicy(DEFAULT_REQUEST_USER_ID),
        systemState: "active",
        accountNumber: "TEST",
        activeBroker: "test",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        maxOrderNotional: 100000,
        maxOrderPctOfNav: undefined,
        maxDailyNotional: 1000000,
        maxQuoteAgeSec: 60
      },
      DEFAULT_REQUEST_USER_ID
    );

    const response = await POST(
      new Request("http://localhost/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: {
            draft_id: "draft-aapl-staleness",
            symbol: "AAPL",
            side: "buy",
            qty: 1,
            order_type: "market",
            limit_usd: null,
            rationale: "test",
            account_label: "Test",
            is_real: false,
            blocked: false,
            warnings: [],
            executed: false
          }
        })
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.proposalId).toBeTruthy();
    // Proves staleness DID fire (reason present) but we staged anyway rather than failing closed.
    expect((body.decision?.reasons ?? []).join(" ")).toContain("staleness_gate");
    expect(listPendingProposals("TEST", DEFAULT_REQUEST_USER_ID)).toHaveLength(1);
  });

  it("returns the existing proposalId (200 deduped) on retry even if the preview is now blocked", async () => {
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { POST } = await import("../app/api/proposals/from-draft/route");

    const draft = {
      draft_id: "draft-aapl-idem",
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      order_type: "market",
      limit_usd: null,
      rationale: "test",
      account_label: "Test",
      is_real: false,
      blocked: false,
      warnings: [],
      executed: false
    };
    const mkReq = () =>
      new Request("http://localhost/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft })
      });
    const base = {
      ...getPolicy(DEFAULT_REQUEST_USER_ID),
      systemState: "active" as const,
      accountNumber: "TEST",
      activeBroker: "test" as const,
      includedIndices: [],
      additionalSymbols: ["AAPL"],
      maxOrderPctOfNav: undefined,
      maxDailyNotional: 1000000
    };

    setPolicy({ ...base, maxOrderNotional: 100000 }, DEFAULT_REQUEST_USER_ID);
    const first = await POST(mkReq());
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    // Tighten the cap so the preview would now block, then retry the same draft_id.
    setPolicy({ ...base, maxOrderNotional: 4.99 }, DEFAULT_REQUEST_USER_ID);
    const retry = await POST(mkReq());
    expect(retry.status).toBe(200);
    const retryBody = await retry.json();
    expect(retryBody.deduped).toBe(true);
    expect(retryBody.proposalId).toBe(firstBody.proposalId);
  });

  it("dry-run preview reports approved when a draft is blocked ONLY by staleness (so the UI shows Stage)", async () => {
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { POST } = await import("../app/api/proposals/from-draft/route");

    setPolicy(
      {
        ...getPolicy(DEFAULT_REQUEST_USER_ID),
        systemState: "active",
        accountNumber: "TEST",
        activeBroker: "test",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        maxOrderNotional: 100000,
        maxOrderPctOfNav: undefined,
        maxDailyNotional: 1000000,
        maxQuoteAgeSec: 60
      },
      DEFAULT_REQUEST_USER_ID
    );

    const response = await POST(
      new Request("http://localhost/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dryRun: true,
          draft: {
            draft_id: "draft-aapl-dryrun-staleness",
            symbol: "AAPL",
            side: "buy",
            qty: 1,
            order_type: "market",
            limit_usd: null,
            rationale: "test",
            account_label: "Test",
            is_real: false,
            blocked: false,
            warnings: [],
            executed: false
          }
        })
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dryRun).toBe(true);
    // Dry-run and commit must agree: staleness-only preview is effectively stageable.
    expect(body.decision?.approved).toBe(true);
  });

  it("does not stage a wash-sale-blocked buy draft", async () => {
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const { getPolicy, insertFillEvent, listPendingProposals, setPolicy, upsertConnectedAccount } = await import("../src/lib/db");
    const { POST } = await import("../app/api/proposals/from-draft/route");

    // PR #8: the wash-sale loss lives in a REAL (alpaca) taxable account — its loss locks the
    // symbol across all accounts. A Test/sim account is EXCLUDED from wash-sale contribution, so
    // the loss must come from a real account. The active account below stays Test purely so the
    // from-draft route resolves the local-sim broker gateway (no broker credentials in tests).
    upsertConnectedAccount({
      id: "chat-draft-real-taxable",
      userId: DEFAULT_REQUEST_USER_ID,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "REAL",
      label: "Taxable",
      taxationType: "taxable",
      isActive: false
    });
    upsertConnectedAccount({
      id: "chat-draft-active-test",
      userId: DEFAULT_REQUEST_USER_ID,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Sim",
      taxationType: "taxable",
      isActive: true
    });
    insertFillEvent({
      userId: DEFAULT_REQUEST_USER_ID,
      accountNumber: "REAL",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled",
      filledAt: "2026-06-01T14:30:00.000Z"
    });
    insertFillEvent({
      userId: DEFAULT_REQUEST_USER_ID,
      accountNumber: "REAL",
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 1,
      price: 90,
      notional: 90,
      status: "filled",
      filledAt: "2026-06-20T14:30:00.000Z"
    });
    setPolicy(
      {
        ...getPolicy(DEFAULT_REQUEST_USER_ID),
        systemState: "active",
        accountNumber: "TEST",
        activeBroker: "test",
        includedIndices: [],
        additionalSymbols: ["AAPL"],
        maxOrderNotional: 100000,
        maxOrderPctOfNav: undefined,
        maxDailyNotional: 1000000
      },
      DEFAULT_REQUEST_USER_ID
    );

    const response = await POST(
      new Request("http://localhost/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draft: {
            draft_id: "draft-aapl-wash-sale",
            symbol: "AAPL",
            side: "buy",
            qty: 1,
            order_type: "market",
            limit_usd: null,
            rationale: "test",
            account_label: "Test",
            is_real: false,
            blocked: false,
            warnings: [],
            executed: false
          }
        })
      })
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("POLICY_BLOCKED");
    expect(body.reasons.join(" ")).toContain("wash-sale lockout");
    expect(listPendingProposals("TEST", DEFAULT_REQUEST_USER_ID)).toHaveLength(0);
  });
});
