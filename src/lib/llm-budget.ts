// G8(a) — hard per-user/day LLM budget ceiling. Extracted to its own module (from triggers.ts) so it
// can be enforced at the spend primitives (withLlmGeneration, retrieveContextDetailed) and at the
// runStrategyOnce gate WITHOUT a strategy↔triggers import cycle. triggers.ts re-exports these for
// callers that already import from it (tests).
//
// CONFIG (who sets it / how to modify): the limit is a per-user POLICY setting
// (`policy.tuning.llmDailyTokenBudget` / `llmDailyCostBudgetUsd`), editable in the dashboard
// Settings → Tuning UI and via `PATCH /api/policy`. When a policy value is unset, it falls back to
// the operator env default (`TRIGGER_LLM_DAILY_TOKEN_BUDGET` / `TRIGGER_LLM_DAILY_COST_BUDGET_USD`).
// 0 / negative / unset on both = no ceiling (default OFF — behavior byte-identical).
//
// ENFORCEMENT: `checkLlmDailyBudget` is the ledger read; `isOverLlmBudget` / `assertWithinLlmBudget`
// are the guards the spend primitives call, so EVERY current and future LLM/RAG spend site is covered
// by one check rather than per-call-site gates.
import { randomUUID } from "crypto";
import { DAILY_RESET_TIME_ZONE, getDb, getPolicy, startOfDayInTimeZone } from "./db";
import { getLlmUsageSummary } from "./llm-usage";
import { getRagUsageSummary } from "./rag-metering";
import type { TradingPolicy } from "./types";

function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Resolve a limit for one dimension. An EXPLICIT per-user policy value always wins over the env
 *  default — including `0`, which means "no limit" (an account opting OUT of an operator-set default).
 *  Only `undefined` (blank in the UI) inherits the env default. Positive = that limit; ≤0 = no ceiling. */
function resolveLimit(policyValue: number | undefined, envName: string): number {
  if (typeof policyValue === "number" && Number.isFinite(policyValue)) {
    return policyValue > 0 ? policyValue : Number.POSITIVE_INFINITY;
  }
  const env = envNum(envName, 0);
  return env > 0 ? env : Number.POSITIVE_INFINITY;
}

export interface LlmBudgetDecision {
  ok: boolean;
  reason?: "token_budget" | "cost_budget";
  tokensToday?: number;
  costUsdToday?: number;
  tokenLimit?: number;
  costLimitUsd?: number;
}

/**
 * Hard per-user/day LLM usage ceiling. Reads the per-user policy limit (env fallback), then sums
 * TODAY's usage (America/New_York day boundary) for `userId` from the ledger in llm-usage.ts across
 * every provider/context/key. Default OFF: with no policy value AND no env limit, the limits are
 * +Infinity and this always returns ok. Pure + DB-read-only so it can be unit-tested directly.
 */
export function checkLlmDailyBudget(userId: string, now: Date = new Date(), connectedAccountId?: string): LlmBudgetDecision {
  // Resilient policy read: the budget check is called from spend primitives (withLlmGeneration,
  // retrieveContextDetailed) in many contexts. If the per-user policy can't be read, degrade to the
  // env-only limit rather than throwing — never let budget bookkeeping break an LLM/RAG call.
  // Resolve the policy for the TARGETED account (a multi-account scheduler run passes its
  // connectedAccountId) so the ceiling reflects that account's tuning, not the active account's; the
  // usage ledger is still summed per-user below. Omitting it resolves the active account (unchanged).
  let tuning: TradingPolicy["tuning"];
  try {
    tuning = getPolicy(userId, connectedAccountId).tuning;
  } catch {
    tuning = undefined;
  }
  const tokenLimit = resolveLimit(tuning?.llmDailyTokenBudget, "TRIGGER_LLM_DAILY_TOKEN_BUDGET");
  const costLimit = resolveLimit(tuning?.llmDailyCostBudgetUsd, "TRIGGER_LLM_DAILY_COST_BUDGET_USD");
  if (!Number.isFinite(tokenLimit) && !Number.isFinite(costLimit)) return { ok: true };

  const sinceIso = startOfDayInTimeZone(now, DAILY_RESET_TIME_ZONE).toISOString();
  // LLM (model) spend from the llm_usage ledger…
  const llmRows = getLlmUsageSummary({ sinceIso }).filter((r) => r.userId === userId);
  let tokensToday = llmRows.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
  let costUsdToday = llmRows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  // …PLUS RAG (Voyage/Pinecone) spend from the rag_usage ledger — the ceiling gates RAG retrieval
  // (retrieveContextDetailed), so RAG usage must count toward it too, else RAG spend never trips the
  // limit. Tokens = embed/rerank input+output; cost = estimated Voyage/Pinecone USD.
  const ragRows = getRagUsageSummary({ sinceIso }).filter((r) => r.userId === userId);
  tokensToday += ragRows.reduce((sum, r) => sum + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
  costUsdToday += ragRows.reduce((sum, r) => sum + (r.costEstUsd ?? 0), 0);

  if (Number.isFinite(tokenLimit) && tokensToday >= tokenLimit) {
    return { ok: false, reason: "token_budget", tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
  }
  if (Number.isFinite(costLimit) && costUsdToday >= costLimit) {
    return { ok: false, reason: "cost_budget", tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
  }
  return { ok: true, tokensToday, costUsdToday, tokenLimit, costLimitUsd: costLimit };
}

// ── Concurrency reservation (TOCTOU fix for concurrent same-user account runs) ────────────────────
//
// checkLlmDailyBudget above is a ledger READ, not a reservation: the scheduler runs up to
// MAX_CONCURRENCY same-user account runs at once, and each can read "under budget" before any records
// its spend, overshooting the ceiling. A per-USER reservation (keyed by userId, since the ledger
// ceiling is per-user) is the missing admission control: a run reserves its worst-case estimate before
// spending; a concurrent run's reserve sees that hold and skips LLM instead of double-committing.
// Stored in the `settings` KV row (no migration), CAS'd inside a transaction().immediate() exactly like
// acquireStrategyLock. Crash-safe-ish: a run that dies without releasing frees its hold after the TTL.

interface LlmReservation { id: string; tokens: number; costUsd: number; reservedAt: string; expiresAt: string }

// TTL for a reservation hold. It must comfortably exceed the longest strategy run + its fire-and-forget
// post-mortem so a LIVE run's reservation never expires before its finally release — an early expiry would
// let a queued same-user run reserve the same headroom and reopen the concurrent-run TOCTOU this closes.
// The TTL is only a backstop for a CRASHED run that never releases; the normal path releases explicitly.
// Env LLM_RESERVATION_TTL_MS, default 15min (well above a worst-case Bull+Bear+Red-Team+RAG+reflection run).
function reservationTtlMs(): number {
  const v = Number(process.env.LLM_RESERVATION_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60_000;
}

const reservationKey = (userId: string): string => `llm_budget_reservation:${userId}`;

/** Resolve the per-user daily token/cost limits (env fallback) for the targeted account. */
function resolveLlmLimits(userId: string, connectedAccountId?: string): { tokenLimit: number; costLimit: number } {
  let tuning: TradingPolicy["tuning"];
  try {
    tuning = getPolicy(userId, connectedAccountId).tuning;
  } catch {
    tuning = undefined;
  }
  return {
    tokenLimit: resolveLimit(tuning?.llmDailyTokenBudget, "TRIGGER_LLM_DAILY_TOKEN_BUDGET"),
    costLimit: resolveLimit(tuning?.llmDailyCostBudgetUsd, "TRIGGER_LLM_DAILY_COST_BUDGET_USD"),
  };
}

/** Today's committed LLM+RAG ledger usage for `userId` (the same sum checkLlmDailyBudget uses). */
function sumLedgerUsage(userId: string, sinceIso: string): { tokens: number; costUsd: number } {
  const llmRows = getLlmUsageSummary({ sinceIso }).filter((r) => r.userId === userId);
  let tokens = llmRows.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
  let costUsd = llmRows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const ragRows = getRagUsageSummary({ sinceIso }).filter((r) => r.userId === userId);
  tokens += ragRows.reduce((sum, r) => sum + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
  costUsd += ragRows.reduce((sum, r) => sum + (r.costEstUsd ?? 0), 0);
  return { tokens, costUsd };
}

/** Conservative worst-case per-run estimate (env-tunable). It's a ceiling GUARD, not exact accounting —
 *  the ledger stays truth; too-high wastes headroom, too-low re-opens overshoot. */
function runReservationEstimate(): { tokens: number; costUsd: number } {
  return { tokens: envNum("LLM_RUN_RESERVATION_TOKENS", 80_000), costUsd: envNum("LLM_RUN_RESERVATION_COST_USD", 1) };
}

/**
 * Atomically reserve `estTokens`/`estCostUsd` of today's LLM+RAG headroom for `userId`. Returns
 * `{ok:false}` when today's ledger usage + live reservations + this estimate would meet/exceed a finite
 * limit — that's the serialization point: a second concurrent same-user run's reserve fails because the
 * first's reservation already consumed the headroom. No ceiling configured → `{ok:true}` with no
 * reservation (default-OFF preserved). Fail-closed on DB error to `{ok:false}` — the CALLER must treat
 * that as "skip LLM", never as a failed run.
 */
export function reserveLlmBudget(
  userId: string,
  estTokens: number,
  estCostUsd: number,
  now: Date = new Date(),
  connectedAccountId?: string
): { ok: boolean; reservationId?: string; reason?: "token_budget" | "cost_budget" } {
  const { tokenLimit, costLimit } = resolveLlmLimits(userId, connectedAccountId);
  if (!Number.isFinite(tokenLimit) && !Number.isFinite(costLimit)) return { ok: true }; // no ceiling → no reservation
  try {
    const db = getDb();
    const key = reservationKey(userId);
    const nowMs = now.getTime();
    const sinceIso = startOfDayInTimeZone(now, DAILY_RESET_TIME_ZONE).toISOString();
    const tx = db.transaction(() => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      let reservations: LlmReservation[] = [];
      if (row) {
        try {
          reservations = ((JSON.parse(row.value) as { reservations?: LlmReservation[] }).reservations ?? []);
        } catch {
          reservations = []; // malformed → reclaim (mirrors acquireStrategyLock)
        }
      }
      reservations = reservations.filter((r) => new Date(r.expiresAt).getTime() > nowMs); // drop expired (crash-safe TTL)
      const ledger = sumLedgerUsage(userId, sinceIso);
      const reservedTokens = reservations.reduce((s, r) => s + (r.tokens ?? 0), 0);
      const reservedCost = reservations.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      // Admission rule. The FIRST run is always admitted when the committed ledger is under the limit —
      // its OWN worst-case estimate must never refuse it, or an account whose budget is smaller than the
      // estimate (e.g. < 80k tokens / < $1) would skip LLM all day even at zero usage. Real spend is still
      // capped per-call by assertWithinLlmBudget. Refuse only when (a) the committed ledger already meets
      // the limit, or (b) a CONCURRENT run's live reservation already claims the headroom this estimate
      // needs — case (b) IS the TOCTOU serialization (a second same-user run stands down).
      const hasConcurrentReservation = reservations.length > 0;
      if (Number.isFinite(tokenLimit) && ledger.tokens >= tokenLimit) return { ok: false as const, reason: "token_budget" as const };
      if (Number.isFinite(costLimit) && ledger.costUsd >= costLimit) return { ok: false as const, reason: "cost_budget" as const };
      if (hasConcurrentReservation) {
        if (Number.isFinite(tokenLimit) && ledger.tokens + reservedTokens + estTokens >= tokenLimit) {
          return { ok: false as const, reason: "token_budget" as const };
        }
        if (Number.isFinite(costLimit) && ledger.costUsd + reservedCost + estCostUsd >= costLimit) {
          return { ok: false as const, reason: "cost_budget" as const };
        }
      }
      const id = randomUUID();
      reservations.push({ id, tokens: estTokens, costUsd: estCostUsd, reservedAt: now.toISOString(), expiresAt: new Date(nowMs + reservationTtlMs()).toISOString() });
      db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).run(key, JSON.stringify({ reservations }), now.toISOString());
      return { ok: true as const, reservationId: id };
    });
    return tx.immediate() as { ok: boolean; reservationId?: string; reason?: "token_budget" | "cost_budget" };
  } catch {
    return { ok: false }; // fail-closed for the reservation; caller degrades to "skip LLM", never a failed run
  }
}

/** Convenience: reserve a strategy run's worst-case estimate. */
export function reserveLlmRunBudget(
  userId: string,
  connectedAccountId?: string,
  now: Date = new Date()
): { ok: boolean; reservationId?: string; reason?: "token_budget" | "cost_budget" } {
  const est = runReservationEstimate();
  return reserveLlmBudget(userId, est.tokens, est.costUsd, now, connectedAccountId);
}

/** Release a reservation (and drop any expired ones). Runs in a `finally`; never throws. */
export function releaseLlmReservation(userId: string, reservationId: string, now: Date = new Date()): void {
  try {
    const db = getDb();
    const key = reservationKey(userId);
    const nowMs = now.getTime();
    db.transaction(() => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (!row) return;
      let reservations: LlmReservation[] = [];
      try {
        reservations = ((JSON.parse(row.value) as { reservations?: LlmReservation[] }).reservations ?? []);
      } catch {
        reservations = [];
      }
      const remaining = reservations.filter((r) => r.id !== reservationId && new Date(r.expiresAt).getTime() > nowMs);
      if (remaining.length === 0) {
        db.prepare("DELETE FROM settings WHERE key = ?").run(key);
      } else {
        db.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run(key, JSON.stringify({ reservations: remaining }), now.toISOString());
      }
    })();
  } catch {
    // release must never throw — it runs in a finally block
  }
}

/** Sum of a user's live (non-expired) reservations. Exposed for tests / diagnostics. */
export function reservedLlmSpend(userId: string, now: Date = new Date()): { tokens: number; costUsd: number } {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(reservationKey(userId)) as { value: string } | undefined;
    if (!row) return { tokens: 0, costUsd: 0 };
    let reservations: LlmReservation[] = [];
    try {
      reservations = ((JSON.parse(row.value) as { reservations?: LlmReservation[] }).reservations ?? []);
    } catch {
      return { tokens: 0, costUsd: 0 };
    }
    const nowMs = now.getTime();
    const live = reservations.filter((r) => new Date(r.expiresAt).getTime() > nowMs);
    return {
      tokens: live.reduce((s, r) => s + (r.tokens ?? 0), 0),
      costUsd: live.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    };
  } catch {
    return { tokens: 0, costUsd: 0 };
  }
}

/** True when `userId` is at/over their daily LLM budget. Cheap wrapper used by the spend primitives. */
export function isOverLlmBudget(userId: string, connectedAccountId?: string): boolean {
  return !checkLlmDailyBudget(userId, new Date(), connectedAccountId).ok;
}

/** Thrown by `assertWithinLlmBudget` — a distinct type so callers can recognize a budget stop vs. a
 *  provider/network error. */
export class LlmBudgetExceededError extends Error {
  readonly reason?: "token_budget" | "cost_budget";
  constructor(decision: LlmBudgetDecision) {
    super(
      `Daily LLM budget ceiling reached (${decision.reason ?? "budget"}): ` +
      `tokensToday=${decision.tokensToday ?? "?"} (limit ${decision.tokenLimit ?? "∞"}), ` +
      `costUsdToday=${decision.costUsdToday ?? "?"} (limit ${decision.costLimitUsd ?? "∞"}). ` +
      `Skipping LLM/RAG spend for the rest of the day.`
    );
    this.name = "LlmBudgetExceededError";
    this.reason = decision.reason;
  }
}

/** Throw `LlmBudgetExceededError` when `userId` is over budget — the durable enforcement primitive
 *  the LLM generation wrapper calls so no model spend slips past the ceiling. No-op (returns) when
 *  under budget or no ceiling is configured. */
export function assertWithinLlmBudget(userId: string, connectedAccountId?: string): void {
  const decision = checkLlmDailyBudget(userId, new Date(), connectedAccountId);
  if (!decision.ok) throw new LlmBudgetExceededError(decision);
}

// ── Operator-level monthly spend ceiling ─────────────────────────────────────────────
//
// LLM_SPEND_CEILING is a global operator-set monthly USD limit (summed across all users).
// When set, the scheduler checks total LLM+RAG spend for the current calendar month before
// allowing any LLM work. Distinct from the per-user daily limits above — this is the operator's
// "stop everything" cap, checked once per tick after the single-leader gate.

/** Resolve the operator-level monthly ceiling. Undefined = no ceiling. */
function monthlySpendCeilingUsd(): number | undefined {
  const v = Number(process.env.LLM_SPEND_CEILING);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Total LLM+RAG cost (USD) across all users for the current calendar month. Never throws. */
function totalMonthlyLlmCostUsd(now: Date = new Date()): number {
  try {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const db = getDb();
    const llmRow = db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage WHERE created_at >= ?")
      .get(monthStart) as { total: number } | undefined;
    const ragRow = db
      .prepare("SELECT COALESCE(SUM(cost_est_usd), 0) AS total FROM rag_usage WHERE created_at >= ?")
      .get(monthStart) as { total: number } | undefined;
    return (llmRow?.total ?? 0) + (ragRow?.total ?? 0);
  } catch {
    return 0; // fail open for the ceiling — never block LLM because we can't read the ledger
  }
}

export interface MonthlyCeilingResult {
  ok: boolean;
  totalUsd: number;
  ceilingUsd: number | undefined;
}

/**
 * Check the operator-level monthly LLM spend ceiling. Called from the scheduler tick
 * after the single-leader gate. When breached, the scheduler skips LLM work for all
 * users but still runs non-LLM safety maintenance (reconciliation, breakers, etc.).
 */
export function checkMonthlyLlmSpendCeiling(now: Date = new Date()): MonthlyCeilingResult {
  const ceiling = monthlySpendCeilingUsd();
  if (ceiling === undefined) return { ok: true, totalUsd: 0, ceilingUsd: undefined };
  const totalUsd = totalMonthlyLlmCostUsd(now);
  return { ok: totalUsd < ceiling, totalUsd, ceilingUsd: ceiling };
}
