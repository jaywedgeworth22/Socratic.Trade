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
    const paperKey = "PK" + "_TEST_PAPER_KEY";
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        broker: "alpaca",
        accountNumber: "287691314",
        apiKey: paperKey,
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
    const liveKey = "AK" + "_TEST_LIVE_KEY";
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        broker: "alpaca",
        accountNumber: "287691314",
        apiKey: liveKey,
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

  it("connects a Tradier SANDBOX account (paper) from an explicit environment selector", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broker: "tradier", apiKey: "tok-sandbox", environment: "paper", isActive: true })
    }));

    expect(response.status).toBe(200);
    const { getActiveConnectedAccount } = await import("../src/lib/db");
    const account = getActiveConnectedAccount();
    expect(account).toMatchObject({
      broker: "tradier",
      environment: "paper",
      baseUrl: "https://sandbox.tradier.com/v1"
    });
    // Single-token broker: the token is stored (encrypted then decrypted on read) and no secret.
    expect(account?.apiKey).toBe("tok-sandbox");
    expect(account?.apiSecret).toBeUndefined();
  });

  it("connects a Tradier PRODUCTION account (live) and picks api.tradier.com", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broker: "tradier", apiKey: "tok-live", environment: "live" })
    }));

    expect(response.status).toBe(200);
    const { listConnectedAccounts } = await import("../src/lib/db");
    expect(listConnectedAccounts()[0]).toMatchObject({
      broker: "tradier",
      environment: "live",
      baseUrl: "https://api.tradier.com/v1"
    });
  });

  it("rejects a Tradier connect with no access token (400)", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broker: "tradier", environment: "paper" })
    }));
    expect(response.status).toBe(400);
  });

  it("creates an explicit inactive local mock Test Account", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const { getActiveConnectedAccount, listConnectedAccounts } = await import("../src/lib/db");

    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broker: "test" })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      accountNumber: "TEST",
      label: "Test Account"
    });
    expect(getActiveConnectedAccount()).toBeUndefined();
    expect(listConnectedAccounts()).toEqual([
      expect.objectContaining({
        broker: "test",
        environment: "paper",
        accountNumber: "TEST",
        label: "Test Account",
        isActive: false
      })
    ]);
  });
});
