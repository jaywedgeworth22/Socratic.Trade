import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "broker-health-pause-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "a".repeat(64);

describe("broker-health auto-pause when orders cannot be placed", () => {
  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb(); // migrate
  });

  beforeEach(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb().exec("DELETE FROM settings; DELETE FROM audit_events;");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies infrastructure place failures vs ordinary rejects", async () => {
    const { isOrderPlacementInfrastructureFailure } = await import("../src/lib/broker-health");
    expect(isOrderPlacementInfrastructureFailure("Tradier HTTP 500: An error occurred while communicating with the backend.")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure('{"errors":["An unexpected error occurred. Please try again."]}')).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("fetch failed")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("ECONNRESET")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("alpaca 403: insufficient buying power")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("You do not have enough buying power for this trade.")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("OrderValidationError: qty < 1")).toBe(false);
  });

  it("halts active policy when health is unhealthy and auto-resumes when healthy", async () => {
    const { getPolicy, setPolicy, listAudit } = await import("../src/lib/db");
    const {
      applyBrokerOrderPlacementPause,
      getBrokerPlacementPauseMarker,
      clearBrokerPlacementPauseMarker
    } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-test-1";
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    const halt = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: {
        isHealthy: false,
        reason: "Tradier order path unavailable: HTTP 500 backend",
        category: "order_capability"
      },
      policy
    });
    expect(halt.action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
    const marker = getBrokerPlacementPauseMarker(userId, accountScope);
    expect(marker?.autoResume).toBe(true);
    expect(marker?.reason).toMatch(/Tradier order path/);

    // Still unhealthy → still paused, no double-flip noise
    policy.systemState = "halted";
    const still = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "still down", category: "order_capability" },
      policy
    });
    expect(still.action).toBe("still_paused");

    // Healthy again → auto-resume
    const resume = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: true },
      policy
    });
    expect(resume.action).toBe("resumed");
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();

    const kinds = listAudit(50, userId).map((a) => a.kind);
    expect(kinds).toContain("broker_placement_auto_halted");
    expect(kinds).toContain("broker_placement_auto_resumed");

    clearBrokerPlacementPauseMarker(userId, accountScope);
  });

  it("does not auto-resume an owner halt that has no placement-pause marker", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-owner-halt";
    const policy = getPolicy(userId);
    policy.systemState = "halted"; // owner stopped
    setPolicy(policy, userId);

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: true },
      policy
    });
    expect(result.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("halted");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
  });

  it("does not claim ownership of halt when already halted without our marker", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-owner-halt-2";
    const policy = getPolicy(userId);
    policy.systemState = "halted";
    setPolicy(policy, userId);

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "OMS down", category: "order_capability" },
      policy
    });
    // already halted by owner — we report still_paused but do NOT write our auto-resume marker
    expect(result.action).toBe("still_paused");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
  });

  it("checkBrokerHealth fails closed when probeOrderCapability returns not ok", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const gateway = {
      getAccounts: async () => [{ accountNumber: "VA1", label: "Sandbox", agenticAllowed: true }],
      getPortfolio: async () => ({
        accountNumber: "VA1",
        totalMarketValue: 100_000,
        buyingPower: 100_000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 100_000
      }),
      probeOrderCapability: async () => ({
        ok: false,
        reason: "Tradier order path unavailable: HTTP 500 backend"
      })
    };
    const health = await checkBrokerHealth(
      "local",
      {
        id: "conn-1",
        broker: "tradier",
        environment: "paper",
        accountNumber: "VA1",
        label: "Sandbox",
        capabilities: undefined
      },
      gateway as never
    );
    expect(health.isHealthy).toBe(false);
    expect(health.category).toBe("order_capability");
    expect(health.reason).toMatch(/Tradier order path/);
  });

  it("checkBrokerHealth treats probe ok + funded account as healthy", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const gateway = {
      getAccounts: async () => [{ accountNumber: "PA1", label: "Paper", agenticAllowed: true }],
      getPortfolio: async () => ({
        accountNumber: "PA1",
        totalMarketValue: 50_000,
        buyingPower: 50_000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 50_000
      }),
      probeOrderCapability: async () => ({ ok: true })
    };
    const health = await checkBrokerHealth(
      "local",
      {
        id: "conn-2",
        broker: "alpaca",
        environment: "paper",
        accountNumber: "PA1",
        label: "Paper",
        capabilities: undefined
      },
      gateway as never
    );
    expect(health.isHealthy).toBe(true);
  });
});
