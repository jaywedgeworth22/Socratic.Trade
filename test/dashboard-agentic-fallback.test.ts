/**
 * connectedAccountAgenticFallback — derives agentic-allowed for a STORED connected account when the
 * live broker enumeration is unavailable (so the readiness badge resolves instead of false-warning).
 */
import { describe, expect, it } from "vitest";
import { accountReadinessForSnapshot, connectedAccountAgenticFallback } from "../src/lib/dashboard";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerageAccount, ConnectedAccount, TradingPolicy } from "../src/lib/types";

function policy(patch: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    paperMode: false,
    activeBroker: "alpaca",
    accountNumber: "A1",
    connectedAccountId: "acct-1",
    ...patch
  };
}

function connectedAccount(patch: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: "acct-1",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    accountNumber: "A1",
    label: "Alpaca Paper",
    isActive: true,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...patch
  };
}

function brokerageAccount(patch: Partial<BrokerageAccount> = {}): BrokerageAccount {
  return {
    accountNumber: "A1",
    label: "Alpaca Paper",
    agenticAllowed: true,
    ...patch
  };
}

describe("connectedAccountAgenticFallback", () => {
  it("Robinhood: brokerage is allowed, IRA/Roth is not (mirrors the live gateway default)", () => {
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "brokerage" } })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "robinhood" })).toBe(true); // missing type → brokerage default
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "roth_ira" } })).toBe(false);
    expect(connectedAccountAgenticFallback({ broker: "robinhood", capabilities: { accountType: "traditional_ira" } })).toBe(false);
  });

  it("Alpaca / Alpaca-MCP / Test: agentic-allowed for all their accounts", () => {
    expect(connectedAccountAgenticFallback({ broker: "alpaca", capabilities: { accountType: "roth_ira" } })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "alpaca-mcp" })).toBe(true);
    expect(connectedAccountAgenticFallback({ broker: "test" })).toBe(true);
  });
});

describe("accountReadinessForSnapshot", () => {
  it("blocks Robinhood when OAuth health is missing", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy({ activeBroker: "robinhood" }),
      activeAccount: connectedAccount({ broker: "robinhood", environment: "live", label: "Agentic" }),
      liveAccounts: [brokerageAccount({ label: "Agentic" })],
      robinhoodMcpHealth: {
        adapter: "mcp",
        ok: false,
        configured: true,
        authenticated: false,
        protocolVersion: "2025-03-26",
        transport: "http+sse",
        tools: [],
        checkedAt: "2026-06-27T00:00:00.000Z",
        error: "No Robinhood MCP access token is stored or configured."
      }
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("Reconnect Robinhood OAuth");
    expect(readiness.detail).toContain("No Robinhood MCP access token");
  });

  it("blocks Alpaca when broker account enumeration fails", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [],
      brokerAccountReadError: "Alpaca credentials rejected"
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("Alpaca account check failed");
    expect(readiness.detail).toContain("Alpaca credentials rejected");
  });

  it("blocks Alpaca when the selected account is missing from live broker accounts", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [brokerageAccount({ accountNumber: "OTHER" })]
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("not available from the broker");
  });

  it("blocks broker accounts that are not agentic-allowed", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [brokerageAccount({ agenticAllowed: false })]
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("not approved for agentic execution");
  });

  it("blocks when the selected account portfolio data cannot be read", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy(),
      activeAccount: connectedAccount(),
      liveAccounts: [brokerageAccount()],
      portfolioReadError: "Alpaca balance endpoint rejected the request"
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("account data check failed");
    expect(readiness.detail).toContain("balance endpoint rejected");
  });

  it("allows the local Test account when selected", () => {
    const readiness = accountReadinessForSnapshot({
      policy: policy({ paperMode: true, activeBroker: "test", accountNumber: "test-local", connectedAccountId: "test-1" }),
      activeAccount: connectedAccount({
        id: "test-1",
        broker: "test",
        accountNumber: "test-local",
        label: "Test"
      }),
      liveAccounts: []
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.detail).toContain("Selected Test account");
  });
});
