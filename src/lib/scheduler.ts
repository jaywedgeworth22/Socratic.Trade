// Background scheduler for autonomous strategy runs.
//
// Dev note: Next.js HMR may hot-reload modules, but the `if (timer) return` guard
// plus Node module caching ensures startScheduler() is effectively a no-op on
// subsequent calls within the same process. In production (`next start`) it runs once.

import { getPolicy } from "./db";
import { isRunAllowedNow } from "./market-hours";
import { runStrategyOnce } from "./strategy";

const TICK_MS = 60_000; // check every 60s; cadence changes take effect within one tick

let timer: NodeJS.Timeout | null = null;
let lastRunAt: string | null = null;
let nextRunAt: string | null = null;

export function getSchedulerState(): { lastRunAt: string | null; nextRunAt: string | null } {
  return { lastRunAt, nextRunAt };
}

export function startScheduler(): void {
  if (timer) return; // guard against double-start

  timer = setInterval(tick, TICK_MS);
  timer.unref(); // don't hold the process open in dev
  console.log("[scheduler] started (tick every 60s)");
}

async function tick(): Promise<void> {
  try {
    const policy = getPolicy();

    if (!policy.enabled || policy.killSwitch || !policy.accountNumber) {
      nextRunAt = null;
      return;
    }

    if (!isRunAllowedNow(policy.runDuringExtendedHours)) {
      // Market is closed; don't update nextRunAt — it will recalculate when open
      return;
    }

    const now = Date.now();
    const cadenceMs = (policy.runCadenceMinutes ?? 60) * 60_000;

    if (lastRunAt !== null) {
      const elapsed = now - new Date(lastRunAt).getTime();
      if (elapsed < cadenceMs) {
        nextRunAt = new Date(new Date(lastRunAt).getTime() + cadenceMs).toISOString();
        return;
      }
    }

    // Due for a run
    lastRunAt = new Date(now).toISOString();
    nextRunAt = new Date(now + cadenceMs).toISOString();

    await runStrategyOnce();
  } catch (err) {
    // Never let a thrown error kill the timer
    console.error("[scheduler] tick error:", err);
  }
}
