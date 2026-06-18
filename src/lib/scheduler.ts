// Background scheduler for autonomous strategy runs.
//
// Dev note: Next.js HMR may hot-reload modules, but the `if (timer) return` guard
// plus Node module caching ensures startScheduler() is effectively a no-op on
// subsequent calls within the same process. In production (`next start`) it runs once.

import { getPolicy, listUsers } from "./db";
import { isRunAllowedNow } from "./market-hours";
import { runStrategyOnce } from "./strategy";
import { refreshDueWebSources } from "./web-sources";

const TICK_MS = 60_000; // check every 60s; cadence changes take effect within one tick

let timer: NodeJS.Timeout | null = null;
const userSchedules: Record<string, {
  lastRunAt: string | null;
  nextRunAt: string | null;
}> = {};

export function getSchedulerState(userId: string = "local"): {
  lastRunAt: string | null;
  nextRunAt: string | null;
} {
  return userSchedules[userId] ?? { lastRunAt: null, nextRunAt: null };
}

export function startScheduler(): void {
  if (timer) return; // guard against double-start

  // Run a tick immediately on start to schedule Next Run right away
  void tick();

  timer = setInterval(tick, TICK_MS);
  timer.unref(); // don't hold the process open in dev
  console.log("[scheduler] started (tick every 60s)");
}

async function tick(): Promise<void> {
  // Refresh backend web sources (congressional trades, etc.) independently of the
  // trading loop — these are low-frequency (cadence-gated, ~daily) data reads that
  // keep the dashboard + agent context fresh even while autonomous trading is paused.
  // Skipped instantly when not yet due; fully self-guarded so it can't break a tick.
  void refreshDueWebSources().catch((err) => console.error("[scheduler] web-source refresh error:", err));

  try {
    // --- Per-User Scheduling ---
    const users = listUsers();

    for (const userId of users) {
      if (!userSchedules[userId]) {
        userSchedules[userId] = {
          lastRunAt: null,
          nextRunAt: null
        };
      }
      const schedule = userSchedules[userId];

      const policy = getPolicy(userId);

      if (!policy.enabled || policy.killSwitch || !policy.accountNumber) {
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

      // Run sequentially to avoid rate-limiting or concurrency issues with external APIs
      await runStrategyOnce(userId).catch((err) => {
        console.error(`[scheduler] error running strategy for user ${userId}:`, err);
      });
    }
  } catch (err) {
    // Never let a thrown error kill the timer
    console.error("[scheduler] tick error:", err);
  }
}
