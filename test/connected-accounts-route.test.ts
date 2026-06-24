import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-connected-route-${randomUUID()}.db`)}`;
});

describe("connected accounts route", () => {
  it("infers Alpaca Paper from PK-prefixed API keys", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        broker: "alpaca",
        accountNumber: "287691314",
        apiKey: "PK5NTFHK6Y3OGJFQ5A",
        apiSecret: "secret"
      })
    }));

    expect(response.status).toBe(200);
    const { listConnectedAccounts } = await import("../src/lib/db");
    const account = listConnectedAccounts()[0];
    expect(account).toMatchObject({
      broker: "alpaca",
      environment: "paper",
      baseUrl: "https://paper-api.alpaca.markets/v2"
    });
  });

  it("uses the live Alpaca endpoint without /v2 for non-paper keys", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        broker: "alpaca",
        accountNumber: "287691314",
        apiKey: "AKEL6RD7DUSFHTBCXL",
        apiSecret: "secret",
        isActive: true
      })
    }));

    expect(response.status).toBe(200);
    const { getActiveConnectedAccount } = await import("../src/lib/db");
    const account = getActiveConnectedAccount();
    expect(account).toMatchObject({
      broker: "alpaca",
      environment: "live",
      baseUrl: "https://api.alpaca.markets"
    });
  });
});
