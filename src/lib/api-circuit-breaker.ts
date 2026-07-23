// Per-credential-lane API circuit breaker.
//
// Providers record health per (service, keySource) lane but nothing GATED calls on it — a dead
// credential got hammered every scan. This breaker sits in front of the network chokepoint
// (fetchWithRetry): when a lane's health says "stopped working" (last 5 calls all failed, per
// getLaneHealth), it short-circuits that specific lane for a cool-down window instead of the whole
// service, then allows ONE half-open probe. A user's own bad key trips only ("finnhub","user"); the
// shared operator lane ("finnhub","env") keeps serving. Default ON; disable with
// API_CIRCUIT_BREAKER_DISABLED=1 (or 0-out API_CIRCUIT_BREAKER_BACKOFF_MS to effectively disable the hold).

import { getLaneHealth } from "./db-health";

/** Thrown by fetchWithRetry when a lane's breaker is open. A distinct type so callers can tell a
 *  short-circuit from a real network error (they degrade to the next tier either way). */
export class CircuitOpenError extends Error {
  readonly service: string;
  readonly keySource: string | null;
  constructor(service: string, keySource: string | null, reason?: string | null) {
    super(`API circuit open for ${service} (${keySource ?? "no-key"} lane): ${reason ?? "lane stopped working"}`);
    this.name = "CircuitOpenError";
    this.service = service;
    this.keySource = keySource;
  }
}

// Module-local, per-process: laneKey -> unix ms until which the lane stays tripped. Mirrors the other
// in-memory caches in this app; no schema/table needed (the durable signal lives in api_health_log).
const trippedUntil = new Map<string, number>();

const laneKey = (service: string, keySource: string | null): string => `${service}${keySource ?? ""}`;

function breakerDisabled(): boolean {
  const v = (process.env.API_CIRCUIT_BREAKER_DISABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Cool-down after a lane trips before a half-open probe is allowed. Env-tunable; default 60s. */
function backoffMs(): number {
  const v = Number(process.env.API_CIRCUIT_BREAKER_BACKOFF_MS ?? 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}

/**
 * Decide whether to skip a call on this (service, keySource) lane.
 * - Tripped and still cooling down -> skip.
 * - Tripped but cool-down elapsed -> clear the timer and allow ONE half-open probe (its health row
 *   re-evaluates the lane on the next call: a success clears stoppedWorking, a failure re-trips).
 * - Not tripped -> consult getLaneHealth; if the lane stoppedWorking, trip it (set cool-down) and skip.
 */
export function apiCircuitBreakerShouldSkip(
  service: string,
  keySource: string | null
): { skip: boolean; reason?: string | null } {
  if (breakerDisabled()) return { skip: false };
  const key = laneKey(service, keySource);
  const now = Date.now();
  const until = trippedUntil.get(key);
  if (until != null) {
    if (now < until) return { skip: true, reason: "circuit-open (lane backed off)" };
    trippedUntil.delete(key); // half-open: let one probe through
    return { skip: false };
  }
  const lane = getLaneHealth(service, keySource);
  if (lane.stoppedWorking) {
    trippedUntil.set(key, now + backoffMs());
    return { skip: true, reason: lane.reason };
  }
  return { skip: false };
}

/** Test-only: clear all tripped lanes so state doesn't leak across cases. */
export function resetApiCircuitBreaker(): void {
  trippedUntil.clear();
}
