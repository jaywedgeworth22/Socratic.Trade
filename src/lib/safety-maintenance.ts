import { LANE_WAITS, withAccountMutation } from "./account-mutation";
import { expireStalePendingProposals } from "./proposal-revalidation";
import { reconcilePendingFills, flagStalePlacingIntents } from "./strategy-execution";
import { notifyStaleLimitOrders } from "./stale-limit-orders";
import { autoRemediateStaleExitOrders } from "./order-replacement";
import { runSyntheticStopMonitor } from "./synthetic-stops";
import { withDeadline } from "./inflight-deadline";
import { startEventLoopLagSampler, stalledMsSince } from "./event-loop-lag";
import type { TradingPolicy, BrokerGateway, ConnectedAccount } from "./types";

export { withDeadline } from "./inflight-deadline";

const BROKER_TIMEOUT_MS = 15_000;

/** Scheduler / safety-maintenance broker lane ceiling (matches BROKER_TIMEOUT_MS). */
export const SCHEDULER_BROKER_TIMEOUT_MS = BROKER_TIMEOUT_MS;

/**
 * Fraction of a blown lane deadline that must be measured event-loop stall before we stop
 * calling the expiry a broker timeout.
 *
 * 0.25 is deliberately conservative: a lane is only re-attributed when at least a QUARTER of
 * its whole 15s window was the process being unable to run any callback at all.  Below that we
 * keep the existing "timeout" classification, so a real broker outage is never explained away
 * as a stall.
 */
export const LANE_STALL_ATTRIBUTION_RATIO = 0.25;

/** A lane deadline that expired, carrying the evidence for WHY it expired. */
export interface LaneDeadlineExpiry extends Error {
  /** Duck-typed marker.  `instanceof` is unreliable here — Next.js HMR can load this module
   *  twice, and the scheduler classifies errors that crossed that boundary. */
  __laneDeadlineExpiry: true;
  /** Wall-clock ms from lane start to deadline expiry (≈ the deadline itself). */
  elapsedMs: number;
  /** Ms within that window the event loop was measurably blocked. */
  stalledMs: number;
  /** stalledMs / elapsedMs. */
  stallRatio: number;
}

export function isLaneDeadlineExpiry(err: unknown): err is LaneDeadlineExpiry {
  return Boolean(err) && typeof err === "object" && (err as LaneDeadlineExpiry).__laneDeadlineExpiry === true;
}

/**
 * `withDeadline` plus honest attribution of the expiry, and visibility of a LATE success.
 *
 * Behaviour is otherwise identical to `withDeadline`, and deliberately so — this is an
 * observability change on a safety path, not a safety change:
 *   * the deadline value is unchanged (still SCHEDULER_BROKER_TIMEOUT_MS),
 *   * no AbortController is passed, so the protective work is never cancelled — it keeps
 *     running to completion exactly as before,
 *   * the expiry still rejects, so the caller still records a lane failure and still escalates
 *     to `lane_degraded` on a streak.
 *
 * What changes is that the rejection now says whether the 15s was spent waiting on a broker or
 * spent on a pinned event loop, and a pass that finishes late is no longer invisible.  Before
 * this, `synthetic-stop-monitor` could log `runSyntheticStopMonitor timeout` and then quietly
 * complete `ok evaluated=6` 196s later, leaving an operator with no way to tell whether stops
 * had in fact been monitored.
 */
export async function withLaneDeadline<T>(work: Promise<T>, ms: number, message: string, lane: string): Promise<T> {
  startEventLoopLagSampler();
  const startedAt = Date.now();
  let expired = false;

  // Late-completion visibility.  Attached unconditionally so the promise is always handled and
  // an abandoned rejection can never surface as an unhandled rejection.
  void work.then(
    () => {
      if (!expired) return;
      console.warn(
        `[maintenance] ${lane} COMPLETED LATE after ${Date.now() - startedAt}ms ` +
          `(deadline was ${ms}ms) — the protective pass did run to completion; ` +
          `the earlier expiry was a lateness signal, not a skipped pass.`
      );
    },
    (err) => {
      if (!expired) return;
      console.warn(`[maintenance] ${lane} FAILED LATE after ${Date.now() - startedAt}ms (deadline was ${ms}ms):`, err);
    }
  );

  try {
    return await withDeadline(work, ms, message);
  } catch (err) {
    // Only the deadline's own expiry is re-attributed.  A real error thrown by the lane's work
    // is passed through untouched so it keeps its own message and classification.
    if (!(err instanceof Error) || err.message !== message) throw err;
    const elapsedMs = Date.now() - startedAt;
    const stalledMs = stalledMsSince(startedAt);
    const stallRatio = elapsedMs > 0 ? stalledMs / elapsedMs : 0;
    const attributed = Object.assign(
      new Error(
        stallRatio >= LANE_STALL_ATTRIBUTION_RATIO
          ? `${message} — event-loop stall ${stalledMs}ms of ${elapsedMs}ms ` +
            `(${Math.round(stallRatio * 100)}%); the broker was not the bottleneck`
          : `${message} (elapsed=${elapsedMs}ms, event-loop stall=${stalledMs}ms)`
      ),
      { __laneDeadlineExpiry: true as const, elapsedMs, stalledMs, stallRatio }
    );
    expired = true;
    throw attributed;
  }
}

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
  await withLaneDeadline(
    gateway.getEquityOrders(policy.accountNumber),
    BROKER_TIMEOUT_MS,
    "getEquityOrders timeout for stale-exit handling",
    "stale-limit-order handling"
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
    await withLaneDeadline(
      // §7 slice 3: whole monitor pass under the account mutation lease (see scheduler lane).
      withAccountMutation(
        { userId, accountNumber: policy.accountNumber, connectedAccountId: policy.connectedAccountId, lane: "stop-monitor" },
        (ctx) => runSyntheticStopMonitor(userId, policy, true, undefined, ctx.assertOwned)
      ),
      BROKER_TIMEOUT_MS,
      "runSyntheticStopMonitor timeout",
      "synthetic-stop-monitor"
    ).catch((err) => console.error("[maintenance] synthetic-stop monitor error:", err));
  }
}
