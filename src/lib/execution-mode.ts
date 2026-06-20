import type { ConnectedAccount, FillSource, TradingPolicy } from "./types";

export type LlmExecutionMode = "test/local" | "broker/paper" | "broker/live";

export type ExecutionAccount = Pick<ConnectedAccount, "id" | "broker" | "environment" | "accountNumber" | "label">;

export interface ExecutionState {
  mode: LlmExecutionMode;
  label: "Test" | "Paper" | "Brokerage";
  broker?: ExecutionAccount["broker"];
  environment?: ExecutionAccount["environment"];
  accountId?: string;
  accountNumber?: string;
  accountLabel?: string;
  usesLocalSimulation: boolean;
  submitsBrokerOrders: boolean;
  clarification: string;
}

type ExecutionPolicy = Pick<TradingPolicy, "paperMode" | "accountNumber" | "connectedAccountId" | "activeBroker">;

export function deriveExecutionState(policy: ExecutionPolicy, activeAccount?: ExecutionAccount): ExecutionState {
  if (policy.paperMode || !activeAccount) {
    return {
      mode: "test/local",
      label: "Test",
      broker: activeAccount?.broker ?? policy.activeBroker,
      environment: activeAccount?.environment,
      accountId: activeAccount?.id ?? policy.connectedAccountId,
      accountNumber: activeAccount?.accountNumber ?? policy.accountNumber,
      accountLabel: activeAccount?.label,
      usesLocalSimulation: true,
      submitsBrokerOrders: false,
      clarification:
        "test/local is the app's local simulator backed by local account state and simulated fills. It is not Alpaca Paper or any broker-hosted paper trading account."
    };
  }

  if (activeAccount.environment === "paper") {
    return {
      mode: "broker/paper",
      label: "Paper",
      broker: activeAccount.broker,
      environment: activeAccount.environment,
      accountId: activeAccount.id,
      accountNumber: activeAccount.accountNumber ?? policy.accountNumber,
      accountLabel: activeAccount.label,
      usesLocalSimulation: false,
      submitsBrokerOrders: true,
      clarification:
        `${brokerLabel(activeAccount.broker)} Paper is a broker-hosted sandbox account. It is distinct from Test (local simulation): broker paper endpoints may be used, but real capital is not at risk.`
    };
  }

  return {
    mode: "broker/live",
    label: "Brokerage",
    broker: activeAccount.broker,
    environment: activeAccount.environment,
    accountId: activeAccount.id,
    accountNumber: activeAccount.accountNumber ?? policy.accountNumber,
    accountLabel: activeAccount.label,
    usesLocalSimulation: false,
    submitsBrokerOrders: true,
    clarification:
      `${brokerLabel(activeAccount.broker)} Brokerage is a broker production account. Broker orders can reach real capital only when policy, approval, and risk gates allow them.`
  };
}

export function llmExecutionMode(stateOrPaperMode: ExecutionState | boolean): LlmExecutionMode {
  if (typeof stateOrPaperMode === "boolean") return stateOrPaperMode ? "test/local" : "broker/live";
  return stateOrPaperMode.mode;
}

export function llmModeClarification(stateOrPaperMode: ExecutionState | boolean): string {
  if (typeof stateOrPaperMode === "boolean") {
    return stateOrPaperMode
      ? "test/local is the app's local simulator backed by local account state and simulated fills. It is not Alpaca Paper or any broker-hosted paper trading account."
      : "broker/live means broker orders can be submitted only when the policy, approval, and risk gates allow it.";
  }
  return stateOrPaperMode.clarification;
}

export function llmFillSource(source: FillSource, executionState?: ExecutionState): LlmExecutionMode {
  if (source === "paper") return "test/local";
  return executionState?.mode === "broker/paper" ? "broker/paper" : "broker/live";
}

function brokerLabel(broker: ExecutionAccount["broker"]): string {
  return broker === "alpaca" ? "Alpaca" : broker === "test" ? "Test" : "Robinhood";
}
