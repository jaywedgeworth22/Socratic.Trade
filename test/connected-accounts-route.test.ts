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

  // Finding #3: environment is the venue authority. A paper connect carrying a live-host baseUrl must
  // be REJECTED (400) so a paper-labeled account can never persist a route to the live api.tradier.com.
  it("rejects a Tradier PAPER connect whose baseUrl host is api.tradier.com (400)", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broker: "tradier", apiKey: "tok-sandbox", environment: "paper", baseUrl: "https://api.tradier.com/v1" })
    }));
    expect(response.status).toBe(400);
    const { listConnectedAccounts } = await import("../src/lib/db");
    expect(listConnectedAccounts()).toHaveLength(0); // nothing persisted
  });

  it("rejects a Tradier LIVE connect whose baseUrl host is sandbox.tradier.com (400)", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broker: "tradier", apiKey: "tok-live", environment: "live", baseUrl: "https://sandbox.tradier.com/v1" })
    }));
    expect(response.status).toBe(400);
  });

  it("accepts a Tradier PAPER connect whose baseUrl host matches (sandbox.tradier.com)", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broker: "tradier", apiKey: "tok-sandbox", environment: "paper", baseUrl: "https://sandbox.tradier.com/v1", isActive: true })
    }));
    expect(response.status).toBe(200);
    const { getActiveConnectedAccount } = await import("../src/lib/db");
    expect(getActiveConnectedAccount()).toMatchObject({ broker: "tradier", environment: "paper", baseUrl: "https://sandbox.tradier.com/v1" });
  });

  it("rejects product creation of test broker accounts without persisting one", async () => {
    const { POST } = await import("../app/api/connected-accounts/route");
    const { getActiveConnectedAccount, listConnectedAccounts } = await import("../src/lib/db");

    const response = await POST(new Request("http://localhost/api/connected-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broker: "test" })
    }));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("test infrastructure");
    expect(getActiveConnectedAccount()).toBeUndefined();
    expect(listConnectedAccounts()).toEqual([]);
  });

  it("never exposes internal test broker rows through the product account API", async () => {
    const { GET } = await import("../app/api/connected-accounts/route");
    const { upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({
      id: "legacy-test-account",
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Test Account",
      isActive: false
    });

    const response = await GET(new Request("http://localhost/api/connected-accounts"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accounts: [] });
  });
});

describe("connected account rename (cosmetic label only)", () => {
  async function seedAccount(overrides: Record<string, unknown> = {}) {
    const { upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({
      id: "acct-1",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA123456",
      label: "Old Name",
      apiKey: "PK_key",
      apiSecret: "secret",
      isActive: true,
      ...overrides
    });
  }

  it("renameConnectedAccount changes ONLY the label — account number and credentials untouched", async () => {
    await seedAccount();
    const { renameConnectedAccount, getActiveConnectedAccount } = await import("../src/lib/db");
    expect(renameConnectedAccount("acct-1", "  Roth IRA — Alpaca  ")).toBe(true);
    const account = getActiveConnectedAccount();
    expect(account?.label).toBe("Roth IRA — Alpaca"); // trimmed
    expect(account?.accountNumber).toBe("PA123456"); // broker identifier preserved
    expect(account?.apiKey).toBe("PK_key"); // credentials preserved
    expect(account?.apiSecret).toBe("secret");
  });

  it("renameConnectedAccount is user-scoped — another user's row is a no-op (false)", async () => {
    await seedAccount();
    const { renameConnectedAccount, getConnectedAccount } = await import("../src/lib/db");
    expect(renameConnectedAccount("acct-1", "Hijacked", "someone-else")).toBe(false);
    expect(getConnectedAccount("acct-1", "local")?.label).toBe("Old Name");
  });

  it("renameConnectedAccount rejects empty/whitespace and over-long names", async () => {
    await seedAccount();
    const { renameConnectedAccount } = await import("../src/lib/db");
    expect(() => renameConnectedAccount("acct-1", "   ")).toThrow(/empty/i);
    expect(() => renameConnectedAccount("acct-1", "x".repeat(121))).toThrow(/too long/i);
  });

  it("PATCH /api/connected-accounts/[id] renames via label and cannot touch the account number", async () => {
    await seedAccount();
    const { PATCH } = await import("../app/api/connected-accounts/[id]/route");
    const { getActiveConnectedAccount } = await import("../src/lib/db");
    const response = await PATCH(
      new Request("http://localhost/api/connected-accounts/acct-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // A malicious/confused client also sends accountNumber — it must be ignored.
        body: JSON.stringify({ label: "Renamed", accountNumber: "HACKED" })
      }),
      { params: Promise.resolve({ id: "acct-1" }) }
    );
    expect(response.status).toBe(200);
    const account = getActiveConnectedAccount();
    expect(account?.label).toBe("Renamed");
    expect(account?.accountNumber).toBe("PA123456"); // unchanged
  });

  it("PATCH rejects a non-string label (400) and an unknown id (404)", async () => {
    await seedAccount();
    const { PATCH } = await import("../app/api/connected-accounts/[id]/route");
    const bad = await PATCH(
      new Request("http://localhost/api/connected-accounts/acct-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: 42 })
      }),
      { params: Promise.resolve({ id: "acct-1" }) }
    );
    expect(bad.status).toBe(400);

    const missing = await PATCH(
      new Request("http://localhost/api/connected-accounts/nope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Whatever" })
      }),
      { params: Promise.resolve({ id: "nope" }) }
    );
    expect(missing.status).toBe(404);
  });
});
