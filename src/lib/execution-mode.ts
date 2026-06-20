import type { ConnectedAccount, FillSource, TradingPolicy } from "./types";

export type LlmExecutionMode = "mock/local" | "broker/paper" | "broker/live";

export type ExecutionAccount = Pick<ConnectedAccount, "id" | "broker" | "environment" | "accountNumber" | "label">;

export interface ExecutionState {
  mode: LlmExecutionMode;
  label: "Mock/Local" | "Broker Paper" | "Broker Live";
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
      mode: "mock/local",
      label: "Mock/Local",
      broker: activeAccount?.broker ?? policy.activeBroker,
      environment: activeAccount?.environment,
      accountId: activeAccount?.id ?? policy.connectedAccountId,
      accountNumber: activeAccount?.accountNumber ?? policy.accountNumber,
      accountLabel: activeAccount?.label,
      usesLocalSimulation: true,
      submitsBrokerOrders: false,
      clarification:
        "mock/local is the app's local simulator backed by local account state and simulated fills. It is not Alpaca Paper or any broker-hosted paper trading account."
    };
  }

  if (activeAccount.environment === "paper") {
    return {
      mode: "broker/paper",
      label: "Broker Paper",
      broker: activeAccount.broker,
      environment: activeAccount.environment,
      accountId: activeAccount.id,
      accountNumber: activeAccount.accountNumber ?? policy.accountNumber,
      accountLabel: activeAccount.label,
      usesLocalSimulation: false,
      submitsBrokerOrders: true,
      clarification:
        `${brokerLabel(activeAccount.broker)} Paper is a broker-hosted sandbox account. It is distinct from Mock/Local: broker paper endpoints may be used, but real capital is not at risk.`
    };
  }

  return {
    mode: "broker/live",
    label: "Broker Live",
    broker: activeAccount.broker,
    environment: activeAccount.environment,
    accountId: activeAccount.id,
    accountNumber: activeAccount.accountNumber ?? policy.accountNumber,
    accountLabel: activeAccount.label,
    usesLocalSimulation: false,
    submitsBrokerOrders: true,
    clarification:
      `${brokerLabel(activeAccount.broker)} Live is a broker production account. Broker orders can reach real capital only when policy, approval, and risk gates allow them.`
  };
}

export function llmExecutionMode(stateOrPaperMode: ExecutionState | boolean): LlmExecutionMode {
  if (typeof stateOrPaperMode === "boolean") return stateOrPaperMode ? "mock/local" : "broker/live";
  return stateOrPaperMode.mode;
}

export function llmModeClarification(stateOrPaperMode: ExecutionState | boolean): string {
  if (typeof stateOrPaperMode === "boolean") {
    return stateOrPaperMode
      ? "mock/local is the app's local simulator backed by local account state and simulated fills. It is not Alpaca Paper or any broker-hosted paper trading account."
      : "broker/live means broker orders can be submitted only when the policy, approval, and risk gates allow it.";
  }
  return stateOrPaperMode.clarification;
}

export function llmFillSource(source: FillSource, executionState?: ExecutionState): LlmExecutionMode {
  if (source === "paper") return "mock/local";
  return executionState?.mode === "broker/paper" ? "broker/paper" : "broker/live";
}

function brokerLabel(broker: ExecutionAccount["broker"]): string {
  return broker === "alpaca" ? "Alpaca" : "Robinhood";
}
