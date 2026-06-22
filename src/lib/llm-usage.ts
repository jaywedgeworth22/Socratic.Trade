// Per-user LLM usage ledger.
//
// Pairs with the operator-funded LLM failover (see `resolveLlmCredential` in db-api-keys.ts):
// when a tenant has no LLM key of their own and falls back to the operator's env key, we record
// who spent and on whose key so the operator can see/attribute cost. Every LLM call records a row
// (the user's own key too) tagged with `keySource` ('user' | 'operator'); token counts are
// best-effort from the provider response (null when the response omits usage).

import crypto from "crypto";
import { getDb } from "./db";
import type { LlmKeySource } from "./db-api-keys";
export { keyFingerprint } from "./db-api-keys";

export interface LlmUsageEntry {
  userId: string;
  provider: "openai" | "anthropic" | string;
  model?: string;
  /** Where in the app the call originated, e.g. "chat", "strategy", "red-team". */
  context?: string;
  /** 'operator' means the operator-funded env key served this (non-owning) user. */
  keySource: Exclude<LlmKeySource, "none">;
  /** Non-secret stable fingerprint of the API key that served this call (see keyFingerprint), so
   *  usage/cost can be measured PER ATTACHED KEY — user-provided or operator. */
  keyRef?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// USD per 1M tokens, [input, output]. Best-effort; unknown models record null cost.
const MODEL_PRICE_PER_M: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "o4-mini": [1.1, 4.4],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5]
};

function priceForModel(model: string | undefined): [number, number] | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (MODEL_PRICE_PER_M[m]) return MODEL_PRICE_PER_M[m];
  // Prefix match (e.g. dated suffixes like claude-haiku-4-5-20251001).
  const hit = Object.keys(MODEL_PRICE_PER_M).find((k) => m.startsWith(k));
  return hit ? MODEL_PRICE_PER_M[hit] : undefined;
}

/** Best-effort cost in USD, or undefined when the model is unpriced or tokens are unknown. */
export function estimateLlmCostUsd(model: string | undefined, promptTokens?: number, completionTokens?: number): number | undefined {
  const price = priceForModel(model);
  if (!price) return undefined;
  const inTok = promptTokens ?? 0;
  const outTok = completionTokens ?? 0;
  if (inTok === 0 && outTok === 0) return undefined;
  return (inTok * price[0] + outTok * price[1]) / 1_000_000;
}

/** Normalize OpenAI (chat-completions + responses) and Anthropic usage shapes. */
export function extractLlmUsage(responseJson: unknown): LlmTokenUsage {
  const u = (responseJson as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!u || typeof u !== "object") return {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const promptTokens = num(u.prompt_tokens) ?? num(u.input_tokens);
  const completionTokens = num(u.completion_tokens) ?? num(u.output_tokens);
  const totalTokens = num(u.total_tokens) ?? (promptTokens !== undefined || completionTokens !== undefined ? (promptTokens ?? 0) + (completionTokens ?? 0) : undefined);
  return { promptTokens, completionTokens, totalTokens };
}

/** Record one LLM call against a user. Never throws — usage accounting must not break an LLM run. */
export function recordLlmUsage(entry: LlmUsageEntry): void {
  try {
    const total =
      entry.promptTokens !== undefined || entry.completionTokens !== undefined ? (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0) : undefined;
    const cost = estimateLlmCostUsd(entry.model, entry.promptTokens, entry.completionTokens);
    getDb()
      .prepare(
        `INSERT INTO llm_usage (id, user_id, provider, model, context, key_source, key_ref, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        entry.userId,
        entry.provider,
        entry.model ?? null,
        entry.context ?? "unknown",
        entry.keySource,
        entry.keyRef ?? null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        total ?? null,
        cost ?? null,
        new Date().toISOString()
      );
  } catch {
    /* ledger is best-effort; never break the caller */
  }
}

export interface LlmUsageRow {
  userId: string;
  provider: string;
  keySource: LlmKeySource;
  /** Per-attached-key fingerprint (see keyFingerprint); null for legacy rows without one. */
  keyRef: string | null;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * Aggregate usage grouped by (userId, provider, keySource, keyRef) — so usage/cost is measured per
 * ATTACHED KEY, not just per source. `sinceIso` bounds the window. `operatorFundedOnly` returns only
 * rows where a NON-`local` tenant spent on the operator key — the figure the operator most cares
 * about while the failover is enabled.
 */
export function getLlmUsageSummary(opts: { sinceIso?: string; operatorFundedOnly?: boolean } = {}): LlmUsageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceIso) {
    where.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  if (opts.operatorFundedOnly) {
    where.push("key_source = 'operator'");
    where.push("user_id != 'local'");
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT user_id, provider, key_source, key_ref,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM llm_usage ${clause}
       GROUP BY user_id, provider, key_source, key_ref
       ORDER BY cost_usd DESC, calls DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.user_id),
    provider: String(r.provider),
    keySource: r.key_source as LlmKeySource,
    keyRef: r.key_ref == null ? null : String(r.key_ref),
    calls: Number(r.calls),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    totalTokens: Number(r.total_tokens),
    costUsd: Number(r.cost_usd)
  }));
}
