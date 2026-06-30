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
});
