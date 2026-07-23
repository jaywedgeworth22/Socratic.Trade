import { getPolicy } from "./db";
import type { OrderSide, SystemState } from "./types";

export function systemStatePlacementBlockReason(
  systemState: SystemState,
  side: OrderSide
): string | undefined {
  if (systemState === "halted") {
    return "System was halted before broker submission. No new order was sent.";
  }
  if (
    (systemState === "close_only" || systemState === "liquidating") &&
    side !== "sell" &&
    side !== "cover"
  ) {
    return `System became ${systemState.replace("_", "-")} before broker submission. Only closing orders are allowed.`;
  }
  return undefined;
}

/**
 * Re-read durable state at the last synchronous boundary before a broker call. Long strategy runs
 * keep an earlier policy snapshot for deterministic analysis, but that snapshot must never outrank
 * an owner Stop/close-only/liquidating command when capital is about to move.
 */
export function freshPlacementBlockReason(input: {
  userId: string;
  connectedAccountId?: string;
  side: OrderSide;
}): string | undefined {
  const currentState = getPolicy(input.userId, input.connectedAccountId).systemState;
  return systemStatePlacementBlockReason(currentState, input.side);
}
