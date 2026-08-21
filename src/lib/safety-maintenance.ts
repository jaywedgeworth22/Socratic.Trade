import { LANE_WAITS, withAccountMutation } from "./account-mutation";
import { expireStalePendingProposals } from "./proposal-revalidation";
import { reconcilePendingFills, flagStalePlacingIntents } from "./strategy-execution";
import { notifyStaleLimitOrders } from "./stale-limit-orders";
import { autoRemediateStaleExitOrders } from "./order-replacement";
import { runSyntheticStopMonitor } from "./synthetic-stops";
import { withDeadline } from "./inflight-deadline";
import type { TradingPolicy, BrokerGateway, ConnectedAccount } from "./types";

export { withDeadline } from "./inflight-deadline";

const BROKER_TIMEOUT_MS = 15_000;

/** Scheduler / safety-maintenance broker lane ceiling (matches BROKER_TIMEOUT_MS). */
export const SCHEDULER_BROKER_TIMEOUT_MS = BROKER_TIMEOUT_MS;

export async function runSafetyMaintenance(
  userId: string,
  policy: TradingPolicy & { accountNumber: string },
  activeAccount: ConnectedAccount,
  gateway: BrokerGateway | undefined
): Promise<void> {
  // 1. Expire stale proposals (No broker calls)
  await expireStalePendingProposals({ userId, policy, accountNumber: policy.accountNumber })
    .catch((err) => console.error("[maintenance] proposal-expiry error:", err));

  if (!gateway) return;

  // 2. Reconcile pending fills
  await withDeadline(
    reconcilePendingFills(gateway, policy.accountNumber, userId, policy.connectedAccountId),
    BROKER_TIMEOUT_MS,
    "reconcilePendingFills broker timeout"
  ).catch((err) => console.error("[maintenance] pending-fill reconcile error:", err));

  // 3. Stale placing-intent recovery
  await withDeadline(
    flagStalePlacingIntents(gateway, policy.accountNumber, userId, policy.connectedAccountId),
    BROKER_TIMEOUT_MS,
    "flagStalePlacingIntents broker timeout"
  ).catch((err) => console.error("[maintenance] stale-placing-intent error:", err));

  // 4. Stale-exit handling
  await withDeadline(
    gateway.getEquityOrders(policy.accountNumber),
    BROKER_TIMEOUT_MS,
    "getEquityOrders timeout for stale-exit handling"
  )
    .then(async (orders) => {
      await notifyStaleLimitOrders({ userId, policy, orders });
      // §7 slice 3: same mutation-lease window as the scheduler's stale-limit-scan lane —
      // busy means the scheduler (or another sequence) is mid-mutation on this account; skip,
      // the periodic lane retries next tick.
      await withAccountMutation(
        { userId, accountNumber: policy.accountNumber, connectedAccountId: policy.connectedAccountId, lane: "stale-exit-replacement", waitMs: LANE_WAITS.staleExit },
        (ctx) => autoRemediateStaleExitOrders({ userId, policy, activeAccount, gateway, orders, fence: ctx.assertOwned })
      );
    })
    .catch((err) => console.error("[maintenance] stale-limit-order handling error:", err));

  // 5. Synthetic stops
  const protectiveState =
    policy.systemState === "active" ||
    policy.systemState === "close_only" ||
    policy.systemState === "liquidating";

  if (protectiveState) {
    await withDeadline(
      // §7 slice 3: whole monitor pass under the account mutation lease (see scheduler lane).
      withAccountMutation(
        { userId, accountNumber: policy.accountNumber, connectedAccountId: policy.connectedAccountId, lane: "stop-monitor" },
        (ctx) => runSyntheticStopMonitor(userId, policy, true, undefined, ctx.assertOwned)
      ),
      BROKER_TIMEOUT_MS,
      "runSyntheticStopMonitor timeout"
    ).catch((err) => console.error("[maintenance] synthetic-stop monitor error:", err));
  }
}
