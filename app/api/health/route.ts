import { getInternalSetting } from "@/lib/db";

export const dynamic = "force-dynamic";

// Real liveness probe (was an unconditional {ok:true}). A health check that can never fail is
// worse than none for a system that can hold real positions — it hides outages. This probes:
//   - DB reachability (the getInternalSetting read throws if SQLite is unwritable/locked), and
//   - scheduler liveness (age of the last tick heartbeat; stale ⇒ autonomy/stops aren't running).
// Returns 503 when a critical check fails so PM2/uptime tooling can act.
export function GET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  let lastTick: string | undefined;
  try {
    lastTick = getInternalSetting<string>("scheduler:lastTick"); // also proves the DB is reachable
    checks.db = "ok";
  } catch (error) {
    ok = false;
    checks.db = error instanceof Error ? error.message : "error";
  }

  if (lastTick) {
    const ageMs = Date.now() - new Date(lastTick).getTime();
    checks.schedulerLastTick = lastTick;
    checks.schedulerAgeSeconds = Math.round(ageMs / 1000);
    // The scheduler ticks every 60s; >5 min of silence is degraded (not a hard failure here —
    // the process may legitimately be a non-scheduler instance).
    if (ageMs > 5 * 60_000) checks.schedulerStale = true;
  } else {
    checks.schedulerLastTick = null;
  }

  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
