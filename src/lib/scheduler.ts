// Background scheduler for autonomous strategy runs.
//
// Dev note: Next.js HMR may hot-reload modules, but the `if (timer) return` guard
// plus Node module caching ensures startScheduler() is effectively a no-op on
// subsequent calls within the same process. In production (`next start`) it runs once.

import { checkAllUserPriceAlerts } from "./alerts";
import { runCongressDailyShareIfDue } from "./congress-share";
import { audit, getActiveConnectedAccount, getLastStrategyRunStartedAt, getPolicy, listConnectedAccounts, listUsers, listWatchlistSymbols, setInternalSetting, setPolicy } from "./db";
import { isRunAllowedNow } from "./market-hours";
import { expireStalePendingProposals } from "./proposal-revalidation";
import { checkRegimeFlip } from "./regime-watch";
import { getBrokerGateway } from "./broker";
import { reconcilePendingFills, runStrategyOnce } from "./strategy";
import { runSyntheticStopMonitor } from "./synthetic-stops";
import { triggerEngineEnabled, triggerMode } from "./triggers";
import { isFilingIngestDue, refreshDueWebSources, refreshFilingBodies } from "./web-sources";
import { symbolsForPolicyUniverse } from "./index-universes";

const TICK_MS = 60_000; // check every 60s; cadence changes take effect within one tick

let timer: NodeJS.Timeout | null = null;
// Schedule state is per (userId, connectedAccountId): each connected account runs autonomously on
// its own cadence/state, so two accounts of the same user neither share a cadence clock nor block
// each other. Keyed by scheduleKey(userId, accountId).
const accountSchedules: Record<string, {
  lastRunAt: string | null;
  nextRunAt: string | null;
}> = {};

function scheduleKey(userId: string, connectedAccountId: string): string {
  return `${userId}::${connectedAccountId}`;
}

// Per-(user,account) re-entrancy guard for the synthetic-stop monitor: a slow broker call must not
// let the next 60s tick start a second concurrent monitor for the same account. globalThis-pinned so
// Next.js HMR module duplication can't defeat the guard with two module instances.
const stopGuardHost = globalThis as unknown as { __stopMonitorInFlight?: Set<string> };
const stopMonitorInFlight: Set<string> =
  stopGuardHost.__stopMonitorInFlight ?? (stopGuardHost.__stopMonitorInFlight = new Set<string>());

/**
 * Boot-time autonomy interlock. A persisted `systemState === "active"` must NOT silently resume
 * live/paper order placement after an unattended restart, crash-loop, or DB restore. Unless an
 * operator explicitly opts in with AUTONOMY_RESUME_ON_BOOT=1, every user left "active" is reverted
 * to "halted" on boot (audited), forcing a human to re-arm autonomy deliberately. "close_only" and
 * "liquidating" are left untouched (they are themselves human-/breaker-set safe states).
 */
export function reconcileAutonomyOnBoot(): void {
  if (process.env.AUTONOMY_RESUME_ON_BOOT === "1") {
    console.log("[scheduler] AUTONOMY_RESUME_ON_BOOT=1 — persisted 'active' autonomy will resume");
    return;
  }
  for (const userId of listUsers()) {
    // Reconcile EVERY connected account, not just the active one — a non-active account left
    // "active" would otherwise auto-resume the moment the multi-account scheduler iterates it.
    // A user with no connected accounts still has a base policy (accountId undefined), so reconcile
    // that too (preserves the original single-account interlock behavior).
    const accountIds: Array<string | undefined> = listConnectedAccounts(userId).map((a) => a.id);
    if (accountIds.length === 0) accountIds.push(undefined);
    for (const accountId of accountIds) {
      try {
        const policy = getPolicy(userId, accountId);
        if (policy.systemState === "active") {
          setPolicy({ ...policy, systemState: "halted" }, userId, accountId);
          audit("autonomy_halted_on_boot", { from: "active", to: "halted", reason: "AUTONOMY_RESUME_ON_BOOT not set" }, userId, accountId);
          console.warn(`[scheduler] autonomy was 'active' for ${userId}/${accountId ?? "(base)"} at boot; reverted to 'halted' (set AUTONOMY_RESUME_ON_BOOT=1 to auto-resume).`);
        }
      } catch (err) {
        console.error(`[scheduler] boot autonomy reconcile failed for ${userId}/${accountId ?? "(base)"}:`, err);
      }
    }
  }
}

export function getSchedulerState(userId: string = "local", connectedAccountId?: string): {
  lastRunAt: string | null;
  nextRunAt: string | null;
} {
  // Default to the active account's schedule (dashboard shows the active account).
  const accountId = connectedAccountId ?? getActiveConnectedAccount(userId)?.id;
  if (!accountId) return { lastRunAt: null, nextRunAt: null };
  return accountSchedules[scheduleKey(userId, accountId)] ?? { lastRunAt: null, nextRunAt: null };
}

export function startScheduler(): void {
  if (timer) return; // guard against double-start

  // Boot interlock runs once, before any tick, so a restored/copied DB cannot resume live
  // execution unattended.
  reconcileAutonomyOnBoot();

  // Run a tick immediately on start to schedule Next Run right away
  void tick();

  timer = setInterval(tick, TICK_MS);
  timer.unref(); // don't hold the process open in dev
  console.log("[scheduler] started (tick every 60s)");
}

async function tick(): Promise<void> {
  // Liveness heartbeat for /api/health: a persisted timestamp each tick lets an external
  // supervisor (PM2/uptime monitor) detect a dead/hung scheduler — i.e. autonomy and the
  // synthetic-stop monitor silently not running. Self-guarded so it can never break a tick.
  try {
    setInternalSetting("scheduler:lastTick", new Date().toISOString());
  } catch (err) {
    console.error("[scheduler] heartbeat write error:", err);
  }

  // Refresh backend web sources (congressional trades, etc.) independently of the
  // trading loop — these are low-frequency (cadence-gated, ~daily) data reads that
  // keep the dashboard + agent context fresh even while autonomous trading is paused.
  // Skipped instantly when not yet due; fully self-guarded so it can't break a tick.
  void refreshDueWebSources().catch((err) => console.error("[scheduler] web-source refresh error:", err));

  // 10-K/10-Q body ingest (weekly cadence, gated on paid Voyage key signal).
  // Collects the union of all user watchlists + policy universes so the shared
  // corpus covers every symbol any active user is monitoring. Fire-and-forget;
  // errors are captured inside refreshFilingBodies and audited there.
  if (isFilingIngestDue()) {
    const symbolSet = new Set<string>();
    for (const userId of listUsers()) {
      try {
        const policy = getPolicy(userId);
        for (const s of symbolsForPolicyUniverse(policy)) symbolSet.add(s);
        for (const item of listWatchlistSymbols(userId)) symbolSet.add(item.symbol);
      } catch {
        // don't let a single user's DB error block the others
      }
    }
    void refreshFilingBodies(Array.from(symbolSet)).catch((err) =>
      console.error("[scheduler] filing-body refresh error:", err)
    );
  }

  // Once-per-day share of company refs + daily closes + the S&P-500 series to congress.trade
  // (App A) so it can avoid spending the shared FMP quota. No-op unless CONGRESS_TRADE_TOKEN +
  // CONGRESS_SHARE_ENABLED are set and the batch hasn't already run today. Fully self-guarded.
  void runCongressDailyShareIfDue(Date.now()).catch((err) =>
    console.error("[scheduler] congress-share daily batch error:", err)
  );

  // Deterministic regime-flip detector (Phase 1) — cheap, self-guarded, runs beside the web-source
  // refresh. Records + announces a regime change; only triggers a run when TRIGGER_ENGINE is on.
  void checkRegimeFlip().catch((err) => console.error("[scheduler] regime check error:", err));

  // Atlas public-repo port: evaluate armed price alerts against live quotes every tick.
  void checkAllUserPriceAlerts().catch((err) => console.error("[scheduler] price-alert check error:", err));

  try {
    // --- Per-Account Scheduling ---
    // Each connected account is scheduled independently: its own per-account policy
    // (systemState, cadence, broker) drives whether/when it runs. Autonomy is opt-in per
    // account — only accounts whose own systemState is "active" trade.
    const dueRuns: Array<{ userId: string; accountId: string }> = [];

    for (const userId of listUsers()) {
      for (const account of listConnectedAccounts(userId)) {
        const accountId = account.id;
        const key = scheduleKey(userId, accountId);
        if (!accountSchedules[key]) {
          // Rehydrate this account's cadence clock from its last real run so a restart/HMR/deploy
          // doesn't fire an immediate run regardless of cadence (in-memory state starts empty).
          accountSchedules[key] = {
            lastRunAt: getLastStrategyRunStartedAt(userId, accountId),
            nextRunAt: null
          };
        }
        const schedule = accountSchedules[key];

        const policy = getPolicy(userId, accountId);

        // Deterministic proposal expiry runs independently of the trading cadence so a stale
        // approval queue self-clears even while the system is halted or the market is closed.
        if (policy.accountNumber) {
          void expireStalePendingProposals({ userId, policy, accountNumber: policy.accountNumber })
            .catch((err) => console.error("[scheduler] proposal-expiry error:", err));
        }

        if (!policy.accountNumber) {
          schedule.nextRunAt = null;
          continue;
        }

        const protectiveState =
          policy.systemState === "active" ||
          policy.systemState === "close_only" ||
          policy.systemState === "liquidating";

        // R2: synthetic trailing-stop monitor — runs every tick in states where risk-reducing exits
        // are allowed. `close_only` and `liquidating` must not disable the very protection that can
        // reduce exposure after a breaker trips. `halted` remains the only no-order state.
        if (protectiveState && !stopMonitorInFlight.has(key)) {
          stopMonitorInFlight.add(key);
          void runSyntheticStopMonitor(userId, policy, true)
            .catch((err) => console.error("[scheduler] synthetic-stop monitor error:", err))
            .finally(() => stopMonitorInFlight.delete(key));
        }

        // Reconcile pending live fills every tick (independent of the strategy cadence) so a broker
        // order that returned non-filled — common on Robinhood, which has no realtime fill stream —
        // doesn't sit pending_reconciliation (invisible to P&L/exposure) until the next, up-to-60-min,
        // strategy run. No-op for Test/paper (no live fills) and gated to broker-backed accounts.
        if (!policy.paperMode) {
          void reconcilePendingFills(getBrokerGateway(policy, userId), policy.accountNumber, userId)
            .catch((err) => console.error("[scheduler] pending-fill reconcile error:", err));
        }

        if (policy.systemState !== "active") {
          schedule.nextRunAt = null;
          continue;
        }

        // Event-only mode: the trigger engine drives runs; skip the fixed-interval cadence.
        // (Default — engine off or mode interval/both — leaves the interval lane unchanged.)
        if (triggerEngineEnabled() && triggerMode() === "event") {
          schedule.nextRunAt = null;
          continue;
        }

        if (!isRunAllowedNow(policy.runDuringExtendedHours)) {
          // Market is closed; don't update nextRunAt — it will recalculate when open
          continue;
        }

        const now = Date.now();
        const cadenceMs = (policy.runCadenceMinutes ?? 60) * 60_000;

        if (schedule.lastRunAt !== null) {
          const elapsed = now - new Date(schedule.lastRunAt).getTime();
          if (elapsed < cadenceMs) {
            schedule.nextRunAt = new Date(new Date(schedule.lastRunAt).getTime() + cadenceMs).toISOString();
            continue;
          }
        }

        // Due for a run
        schedule.lastRunAt = new Date(now).toISOString();
        schedule.nextRunAt = new Date(now + cadenceMs).toISOString();
        dueRuns.push({ userId, accountId });
      }
    }

    // Run with bounded concurrency (max 3 at a time) to balance throughput and API rate limits
    const MAX_CONCURRENCY = 3;
    const executing = new Set<Promise<unknown>>();

    for (const { userId, accountId } of dueRuns) {
      const p = runStrategyOnce(userId, { connectedAccountId: accountId })
        .catch((err) => {
          console.error(`[scheduler] error running strategy for ${userId}/${accountId}:`, err);
        })
        .finally(() => {
          executing.delete(p);
        });

      executing.add(p);
      if (executing.size >= MAX_CONCURRENCY) {
        await Promise.race(executing);
      }
    }
    
    await Promise.all(executing);
  } catch (err) {
    // Never let a thrown error kill the timer
    console.error("[scheduler] tick error:", err);
  }
}
