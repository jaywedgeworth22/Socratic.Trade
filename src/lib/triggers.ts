// Event-driven LLM-trigger engine (Phase 0/2 of the expert-panel design — see
// docs/event-driven-llm-triggering.md for the full policy).
//
// DEFAULT OFF: with TRIGGER_ENGINE unset, the scheduler runs on the fixed interval exactly as
// before and submitMaterialEvent/broadcastMaterialEvent are no-ops. When enabled, material events
// are deduped, COALESCED over a debounce window (a storm of events → ONE run), then GATED
// (market hours + global/per-symbol cooldown + hourly/daily caps) before firing one strategy run.
//
// Defaults below are the panel's reconciled paper-mode numbers. Per-user policy fields + the $/token
// budget ceiling are deferred (the policy schema was just migrated; env config ships first).

import { audit, getPolicy, listUsers } from "./db";
import { isRunAllowedNow } from "./market-hours";
import { runStrategyOnce } from "./strategy";

export type TriggerMode = "interval" | "event" | "both";

export interface MaterialEvent {
  type: string; // "sec8k" | "regime" | "technical" | "insider" | "congress" | ...
  symbol?: string;
  sourceId: string; // stable id for dedup (accession, filing id, regime transition, ...)
  reason?: string;
}

interface UserTriggerState {
  buffer: MaterialEvent[];
  firstEventMs: number | null;
  timer: NodeJS.Timeout | null;
  lastRunMs: number;
  hourStartMs: number;
  hourCount: number;
  dayStartMs: number;
  dayCount: number;
  perSymbolMs: Map<string, number>;
  dedup: Map<string, number>; // key -> expiry ms
}

const globalForTriggers = globalThis as unknown as { __triggerState?: Map<string, UserTriggerState> };
const states: Map<string, UserTriggerState> = globalForTriggers.__triggerState ?? (globalForTriggers.__triggerState = new Map());

// ── Config (env, with the panel's default numbers) ────────────────────────────
function envFlag(name: string, dflt = false): boolean {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  if (!v) return dflt;
  return ["1", "true", "on", "yes"].includes(v);
}
function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

export function triggerEngineEnabled(): boolean {
  return envFlag("TRIGGER_ENGINE", false);
}
export function triggerMode(): TriggerMode {
  const m = String(process.env.TRIGGER_MODE ?? "both").trim().toLowerCase();
  return m === "interval" || m === "event" ? m : "both";
}
const debounceMs = () => envNum("TRIGGER_DEBOUNCE_MS", 90_000);
const maxDebounceMs = () => envNum("TRIGGER_MAX_DEBOUNCE_MS", 300_000);
const maxBatch = () => envNum("TRIGGER_MAX_BATCH", 25);
const globalCooldownMs = () => envNum("TRIGGER_GLOBAL_COOLDOWN_SEC", 300) * 1000;
const perSymbolCooldownMs = () => envNum("TRIGGER_PER_SYMBOL_COOLDOWN_SEC", 1800) * 1000;
const maxRunsPerHour = () => envNum("TRIGGER_MAX_RUNS_PER_HOUR", 6);
const maxRunsPerDay = () => envNum("TRIGGER_MAX_RUNS_PER_DAY", 24);
const dedupTtlMs = () => envNum("TRIGGER_DEDUP_TTL_SEC", 86_400) * 1000;

function stateFor(userId: string): UserTriggerState {
  let s = states.get(userId);
  if (!s) {
    s = { buffer: [], firstEventMs: null, timer: null, lastRunMs: 0, hourStartMs: 0, hourCount: 0, dayStartMs: 0, dayCount: 0, perSymbolMs: new Map(), dedup: new Map() };
    states.set(userId, s);
  }
  return s;
}

function rollWindows(s: UserTriggerState, now: number): void {
  if (now - s.hourStartMs >= 3_600_000) { s.hourStartMs = now; s.hourCount = 0; }
  if (now - s.dayStartMs >= 86_400_000) { s.dayStartMs = now; s.dayCount = 0; }
}

/** Submit a material event for one user. No-op unless the engine is on and mode allows events. */
export function submitMaterialEvent(userId: string, event: MaterialEvent): void {
  if (!triggerEngineEnabled() || triggerMode() === "interval") return;
  const s = stateFor(userId);
  const now = Date.now();

  // Idempotency: drop duplicates (webhook retry, same filing seen twice) before they enter the window.
  const key = `${event.type}:${event.symbol ?? "*"}:${event.sourceId}`;
  const existing = s.dedup.get(key);
  if (existing && existing > now) return;
  s.dedup.set(key, now + dedupTtlMs());
  if (s.dedup.size > 2000) for (const [k, exp] of s.dedup) if (exp <= now) s.dedup.delete(k);

  s.buffer.push(event);
  if (s.firstEventMs === null) s.firstEventMs = now;

  const sinceFirst = now - (s.firstEventMs ?? now);
  if (s.buffer.length >= maxBatch() || sinceFirst >= maxDebounceMs()) {
    void fire(userId);
    return;
  }
  if (s.timer) clearTimeout(s.timer);
  const quiet = debounceMs();
  const ceilingRemaining = maxDebounceMs() - sinceFirst;
  s.timer = setTimeout(() => void fire(userId), Math.max(0, Math.min(quiet, ceilingRemaining)));
  s.timer.unref?.();
}

/** Fan a global material event (8-K, regime, etc.) out to every active user. */
export function broadcastMaterialEvent(event: MaterialEvent): void {
  if (!triggerEngineEnabled() || triggerMode() === "interval") return;
  for (const userId of listUsers()) {
    const policy = getPolicy(userId);
    if (policy.systemState === "active" && policy.accountNumber) submitMaterialEvent(userId, event);
  }
}

async function fire(userId: string): Promise<void> {
  const s = stateFor(userId);
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  const batch = s.buffer;
  s.buffer = [];
  s.firstEventMs = null;
  if (batch.length === 0) return;

  const decision = admitRun(userId, batch);
  if (!decision.ok) {
    audit("trigger_suppressed", { userId, reason: decision.reason, events: batch.length, types: distinctTypes(batch) }, userId);
    return;
  }

  const now = Date.now();
  rollWindows(s, now);
  s.lastRunMs = now;
  s.hourCount += 1;
  s.dayCount += 1;
  for (const e of batch) if (e.symbol) s.perSymbolMs.set(e.symbol, now);
  audit("trigger_run", { userId, events: batch.length, types: distinctTypes(batch), reason: "event" }, userId);
  try {
    await runStrategyOnce(userId);
  } catch (err) {
    console.error("[triggers] event-driven run error:", err);
  }
}

/** Gate a candidate run. Exported so a diagnostic route can preview the decision. */
export function admitRun(userId: string, batch: MaterialEvent[]): { ok: boolean; reason?: string } {
  if (!triggerEngineEnabled()) return { ok: false, reason: "engine_off" };
  if (triggerMode() === "interval") return { ok: false, reason: "mode_interval" };
  const policy = getPolicy(userId);
  if (policy.systemState !== "active") return { ok: false, reason: "system_not_active" };
  if (!policy.accountNumber) return { ok: false, reason: "no_account" };
  if (!isRunAllowedNow(policy.runDuringExtendedHours)) return { ok: false, reason: "market_closed" };

  const s = stateFor(userId);
  const now = Date.now();
  rollWindows(s, now);
  if (now - s.lastRunMs < globalCooldownMs()) return { ok: false, reason: "global_cooldown" };
  if (s.hourCount >= maxRunsPerHour()) return { ok: false, reason: "hourly_cap" };
  if (s.dayCount >= maxRunsPerDay()) return { ok: false, reason: "daily_cap" };
  // Suppress only if EVERY event's symbol is still in its per-symbol cooldown.
  const hasFresh = batch.some((e) => !e.symbol || now - (s.perSymbolMs.get(e.symbol) ?? 0) >= perSymbolCooldownMs());
  if (!hasFresh) return { ok: false, reason: "per_symbol_cooldown" };
  return { ok: true };
}

function distinctTypes(batch: MaterialEvent[]): string[] {
  return Array.from(new Set(batch.map((e) => e.type)));
}
