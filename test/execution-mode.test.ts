import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { deriveExecutionState, fillSourceForExecutionMode, llmExecutionMode, llmFillSource, llmModeClarification, getThemeClasses, type ExecutionAccount } from "../src/lib/execution-mode";
import type { ConnectedAccount } from "../src/lib/types";

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

const mockConnectedAccount: ConnectedAccount = {
  id: "conn-1",
  userId: "local",
  broker: "alpaca",
  environment: "paper",
  accountNumber: "APCA-PAPER",
  label: "Alpaca Paper",
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe("deriveExecutionState", () => {
  it("keeps Test local even when a broker paper account is active", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, paperMode: true }, alpacaPaperAccount);

    expect(state.mode).toBe("test/local");
    expect(state.label).toBe("Test");
    expect(state.usesLocalSimulation).toBe(true);
    expect(state.submitsBrokerOrders).toBe(false);
    expect(llmExecutionMode(state)).toBe("test/local");
    expect(llmModeClarification(state)).toContain("not Alpaca Paper");
  });

  it("derives Paper from broker-routed policy plus a paper account", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, paperMode: false }, alpacaPaperAccount);

    expect(state.mode).toBe("broker/paper");
    expect(state.label).toBe("Paper");
    expect(state.broker).toBe("alpaca");
    expect(state.environment).toBe("paper");
    expect(state.usesLocalSimulation).toBe(false);
    expect(state.submitsBrokerOrders).toBe(true);
    expect(state.clarification).toContain("Alpaca Paper");
    expect(state.clarification).toContain("real capital is not at risk");
    expect(fillSourceForExecutionMode(state)).toBe("paper");
    expect(llmFillSource("paper", state)).toBe("broker/paper");
  });

  it("derives Brokerage from broker-routed policy plus a live account", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, paperMode: false }, alpacaLiveAccount);

    expect(state.mode).toBe("broker/live");
    expect(state.label).toBe("Brokerage");
    expect(state.environment).toBe("live");
    expect(state.usesLocalSimulation).toBe(false);
    expect(state.submitsBrokerOrders).toBe(true);
    expect(state.clarification).toContain("real capital");
    expect(fillSourceForExecutionMode(state)).toBe("live");
    expect(llmFillSource("live", state)).toBe("broker/live");
  });

  it("falls back to Test when broker-routed policy has no active account", () => {
    const state = deriveExecutionState({ ...DEFAULT_POLICY, paperMode: false, activeBroker: "alpaca" }, undefined);

    expect(state.mode).toBe("test/local");
    expect(state.broker).toBe("alpaca");
    expect(state.usesLocalSimulation).toBe(true);
    expect(state.submitsBrokerOrders).toBe(false);
  });

  it("supports the boolean overload (paperMode = true/false, activeAccount)", () => {
    // 1. paperMode: true
    expect(deriveExecutionState(true, mockConnectedAccount)).toBe("mock");
    expect(deriveExecutionState(true, undefined)).toBe("mock");

    // 2. paperMode: false, activeAccount environment = paper
    expect(deriveExecutionState(false, mockConnectedAccount)).toBe("paper");

    // 3. paperMode: false, activeAccount environment = live
    const liveConnectedAccount: ConnectedAccount = {
      ...mockConnectedAccount,
      id: "conn-2",
      environment: "live"
    };
    expect(deriveExecutionState(false, liveConnectedAccount)).toBe("live");

    // 4. paperMode: false, activeAccount = undefined
    expect(deriveExecutionState(false, undefined)).toBe("mock");
  });
});

describe("getThemeClasses", () => {
  it("returns correct styling classes for each state", () => {
    expect(getThemeClasses("mock")).toContain("slate-500");
    expect(getThemeClasses("paper")).toContain("emerald-500");
    expect(getThemeClasses("live")).toContain("amber-500");
  });
});
