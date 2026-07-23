import type { TradingPolicy } from "./types";

export const STOPPED_PROPOSAL_ACTION_TITLE = "Start the system first.";
export const STOPPED_PROPOSAL_ACTION_DESCRIPTION =
  "Run once can create proposals while stopped, but accepting or rejecting a proposal requires the system to be running.";
export const STOPPED_PROPOSAL_ACTION_MESSAGE = `${STOPPED_PROPOSAL_ACTION_TITLE} ${STOPPED_PROPOSAL_ACTION_DESCRIPTION}`;

export function isProposalActionStopped(policy: Pick<TradingPolicy, "systemState">): boolean {
  return policy.systemState === "halted";
}
