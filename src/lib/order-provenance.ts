import { isBracketOrderClass } from "./broker-side";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import { normalizeSymbol } from "./money";
import type { EquityOrder } from "./types";

const OWNER_CANCELLED_PROTECTIVE_STOP_PREFIX = "owner_cancelled_protective_stop:";
const APP_MANAGED_STOP_CLIENT_PREFIXES = ["protstop-", "sstop-"] as const;

export type AutoReplaceProvenanceSkipReason = "bracket_leg" | "not_app_placed";

/** App placement always sets a broker client_order_id (refId). Absence means the owner placed it at the broker. */
export function isAppPlacedBrokerOrder(order: Pick<EquityOrder, "clientOrderId">): boolean {
  return typeof order.clientOrderId === "string" && order.clientOrderId.trim().length > 0;
}

export function isAppManagedProtectiveStopClientOrderId(clientOrderId: string | undefined): boolean {
  const ref = String(clientOrderId ?? "").trim().toLowerCase();
  return APP_MANAGED_STOP_CLIENT_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

/** Returns a skip reason when automated stale-exit cancel-replace must not touch this order. */
export function autoReplaceProvenanceSkipReason(order: EquityOrder): AutoReplaceProvenanceSkipReason | null {
  if (isBracketOrderClass(order.orderClass)) return "bracket_leg";
  if (!isAppPlacedBrokerOrder(order)) return "not_app_placed";
  return null;
}

function ownerCancelledProtectiveStopKey(userId: string, accountNumber: string, symbol: string): string {
  return `${OWNER_CANCELLED_PROTECTIVE_STOP_PREFIX}${userId}:${accountNumber}:${normalizeSymbol(symbol)}`;
}

/** Tombstone: the owner manually cancelled an app-managed protective stop for this symbol. */
export function recordOwnerCancelledProtectiveStop(userId: string, accountNumber: string, symbol: string): void {
  setInternalSetting(ownerCancelledProtectiveStopKey(userId, accountNumber, symbol), {
    cancelledAt: new Date().toISOString()
  });
}

export function hasOwnerCancelledProtectiveStop(userId: string, accountNumber: string, symbol: string): boolean {
  return Boolean(getInternalSetting(ownerCancelledProtectiveStopKey(userId, accountNumber, symbol)));
}
