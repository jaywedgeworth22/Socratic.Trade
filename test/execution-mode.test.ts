import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { deriveExecutionState, llmExecutionMode, llmModeClarification, type ExecutionAccount } from "../src/lib/execution-mode";

const alpacaPaperAccount: ExecutionAccount = {
  id: "alpaca-paper",
  broker: "alpaca",
  environment: "paper",
  accountNumber: "APCA-PAPER",
  label: "Alpaca Paper"
};

const alpacaLiveAccount: ExecutionAccount = {
  ...alpacaPaperAccount,
  id: "alpaca-live",
  environment: "live",
  accountNumber: "APCA-LIVE",
  label: "Alpaca Live"
};

describe("deriveExecutionState", () => {
  it("keeps Mock/Local local even when a broker paper account is active", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, paperMode: true }, alpacaPaperAccount);

    expect(state.mode).toBe("mock/local");
    expect(state.label).toBe("Mock/Local");
    expect(state.usesLocalSimulation).toBe(true);
    expect(state.submitsBrokerOrders).toBe(false);
    expect(llmExecutionMode(state)).toBe("mock/local");
    expect(llmModeClarification(state)).toContain("not Alpaca Paper");
  });

  it("derives Broker Paper from broker-routed policy plus a paper account", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, paperMode: false }, alpacaPaperAccount);

    expect(state.mode).toBe("broker/paper");
    expect(state.label).toBe("Broker Paper");
    expect(state.broker).toBe("alpaca");
    expect(state.environment).toBe("paper");
    expect(state.usesLocalSimulation).toBe(false);
    expect(state.submitsBrokerOrders).toBe(true);
    expect(state.clarification).toContain("Alpaca Paper");
    expect(state.clarification).toContain("real capital is not at risk");
  });

  it("derives Broker Live from broker-routed policy plus a live account", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, paperMode: false }, alpacaLiveAccount);

    expect(state.mode).toBe("broker/live");
    expect(state.label).toBe("Broker Live");
    expect(state.environment).toBe("live");
    expect(state.usesLocalSimulation).toBe(false);
    expect(state.submitsBrokerOrders).toBe(true);
    expect(state.clarification).toContain("real capital");
  });

  it("falls back to Mock/Local when broker-routed policy has no active account", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, paperMode: false, activeBroker: "alpaca" }, undefined);

    expect(state.mode).toBe("mock/local");
    expect(state.broker).toBe("alpaca");
    expect(state.usesLocalSimulation).toBe(true);
    expect(state.submitsBrokerOrders).toBe(false);
  });
});
