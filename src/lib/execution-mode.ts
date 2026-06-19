import type { FillSource } from "./types";

export type LlmExecutionMode = "mock/local" | "live";

export function llmExecutionMode(paperMode: boolean): LlmExecutionMode {
  return paperMode ? "mock/local" : "live";
}

export function llmModeClarification(paperMode: boolean): string {
  return paperMode
    ? "mock/local is the app's local simulator backed by local account state and simulated fills. It is not Alpaca Paper or any broker-hosted paper trading account."
    : "live means broker orders can be submitted only when the policy, approval, and risk gates allow it.";
}

export function llmFillSource(source: FillSource): LlmExecutionMode {
  return source === "paper" ? "mock/local" : "live";
}
