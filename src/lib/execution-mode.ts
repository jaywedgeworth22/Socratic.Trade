import type { ConnectedAccount, ExecutionMode, FillSource, TradingPolicy } from "./types";

export type LlmExecutionMode = ExecutionMode;

// taxationType is included so the strategy prompt builder can classify an IRA buyer with the same
// source-of-truth precedence as the wash-sale gate (isIraTaxRegime). The runtime value passed here
// is the full ConnectedAccount row, so this only widens the compile-time view — no call site change.
export type ExecutionAccount = Pick<ConnectedAccount, "id" | "broker" | "environment" | "accountNumber" | "label" | "capabilities" | "taxationType">;

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

export function deriveExecutionState(paperMode: boolean, activeAccount?: ConnectedAccount): "mock" | "paper" | "live";
export function deriveExecutionState(policy: ExecutionPolicy, activeAccount?: ExecutionAccount): ExecutionState;
export function deriveExecutionState(
  first: boolean | ExecutionPolicy,
  second?: ConnectedAccount | ExecutionAccount
): "mock" | "paper" | "live" | ExecutionState {
  if (typeof first === "boolean") {
    const paperMode = first;
    const activeAccount = second as ConnectedAccount | undefined;
    if (paperMode || !activeAccount) {
      return "mock";
    }
    if (activeAccount.environment === "paper") {
      return "paper";
    }
    return "live";
  } else {
    const policy = first;
    const activeAccount = second as ExecutionAccount | undefined;
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
}

export function getThemeClasses(state: "mock" | "paper" | "live"): string {
  switch (state) {
    case "mock":
      return "bg-slate-500/10 border-slate-500/30 text-slate-400";
    case "paper":
      return "bg-emerald-500/10 border-emerald-500/30 text-emerald-400";
    case "live":
      return "bg-amber-500/10 border-amber-500/30 text-amber-400";
    default:
      return "bg-slate-500/10 border-slate-500/30 text-slate-400";
  }
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
  if (executionState) return executionState.mode;
  if (source === "paper") return "test/local";
  return "broker/live";
}

export function fillSourceForExecutionMode(stateOrMode: ExecutionState | ExecutionMode): FillSource {
  const mode = typeof stateOrMode === "string" ? stateOrMode : stateOrMode.mode;
  return mode === "broker/live" ? "live" : "paper";
}

function brokerLabel(broker: ExecutionAccount["broker"]): string {
  return (broker === "alpaca" || broker === "alpaca-mcp") ? "Alpaca" : broker === "test" ? "Test" : "Robinhood";
}
