// Per-user RAG (Voyage / Pinecone) usage ledger.
//
// Mirrors src/lib/llm-usage.ts: every Voyage embed or rerank call and every Pinecone
// upsert or query call records a row so the operator can meter API spend.
// RAG keys are app-funded (resolved via resolveApiKey), so the userId is always 'local'
// in the system path; per-user separation happens when a user provides their own key.
//
// Pricing notes (approximate, as of 2026-06):
//   - voyage-finance-2 embed: ~$0.00010/1K tokens
//   - rerank-2.5:             ~$0.00070/1K tokens
//   - Pinecone: serverless — metered by Read/Write Request Units (not tokenized)

import crypto from "crypto";
import { getDb } from "./db";
import { pushRagUsage } from "./usage-monitor-push";

// ── Types ────────────────────────────────────────────────────────────────────

export type RagOperation = "embed" | "rerank" | "query" | "upsert";

export interface RagUsageEntry {
  userId?: string;
  operation: RagOperation;
  provider?: string;
  model?: string;
  /** Estimated input tokens (or texts count for Pinecone ops). */
  tokensIn?: number;
  /** Estimated output tokens (or records count for Pinecone ops). */
  tokensOut?: number;
  /** Number of items in the batch (texts / records). */
  batchCount?: number;
}

export interface RagUsageRow {
  userId: string;
  operation: RagOperation;
  provider: string;
  model: string | null;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  batchCount: number;
  costEstUsd: number;
}

// ── Cost estimation (best-effort) ────────────────────────────────────────────

const VOYAGE_PRICE_PER_1K_TOKENS: Record<string, { embed: number; rerank: number }> = {
  "voyage-finance-2": { embed: 0.0001, rerank: 0.0007 },
  "rerank-2.5": { embed: 0, rerank: 0.0007 },
  "rerank-2": { embed: 0, rerank: 0.0007 },
};

function estimateRagCost(
  provider: string,
  model: string | undefined,
  operation: RagOperation,
  tokensIn: number
): number | undefined {
  if (provider !== "voyage") return undefined;
  if (operation === "query" || operation === "upsert") return undefined;
  const modelKey = model || "voyage-finance-2";
  const prices =
    VOYAGE_PRICE_PER_1K_TOKENS[modelKey] ?? VOYAGE_PRICE_PER_1K_TOKENS["voyage-finance-2"];
  if (!prices) return undefined;
  const rate = operation === "embed" ? prices.embed : prices.rerank;
  return (tokensIn * rate) / 1000;
}

// ── Approximate token counting ───────────────────────────────────────────────

/** Crude token estimate from word count (Voyage uses a subword tokenizer; this is a floor). */
function approxTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + (t.trim().split(/\s+/).filter(Boolean).length || 1), 0);
}

// ── Record ───────────────────────────────────────────────────────────────────

/** Record a RAG operation against a user. Never throws. */
export function recordRagUsage(entry: RagUsageEntry): void {
  try {
    const userId = entry.userId || "local";
    const provider = entry.provider || "voyage";
    const tokensIn = entry.tokensIn ?? 0;
    const tokensOut = entry.tokensOut ?? 0;
    const batchCount = entry.batchCount ?? 1;
    const cost = estimateRagCost(provider, entry.model, entry.operation, tokensIn);

    getDb()
      .prepare(
        `INSERT INTO rag_usage (id, user_id, operation, provider, model, tokens_in, tokens_out, batch_count, cost_est_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        userId,
        entry.operation,
        provider,
        entry.model ?? null,
        tokensIn,
        tokensOut,
        batchCount,
        cost ?? null,
        new Date().toISOString()
      );
    // Fire-and-forget forward to the API Usage Monitor (no-op unless configured; never throws).
    pushRagUsage({
      provider,
      operation: entry.operation,
      model: entry.model,
      userId,
      tokensIn,
      tokensOut,
      batchCount,
      costUsd: cost,
    });
  } catch {
    /* ledger is best-effort; never break the caller */
  }
}

/**
 * Convenience: record a Voyage embed call.
 */
export function meterEmbed(texts: string[], model?: string): void {
  const tokens = approxTokens(texts);
  recordRagUsage({
    operation: "embed",
    provider: "voyage",
    model: model || "voyage-finance-2",
    tokensIn: tokens,
    batchCount: texts.length
  });
}

/**
 * Convenience: record a Voyage rerank call.
 */
export function meterRerank(query: string, documents: string[], model?: string): void {
  const tokens = approxTokens([query, ...documents]);
  recordRagUsage({
    operation: "rerank",
    provider: "voyage",
    model: model || "rerank-2.5",
    tokensIn: tokens,
    batchCount: documents.length
  });
}

/**
 * Convenience: record a Pinecone query.
 */
export function meterPineconeQuery(recordCount: number): void {
  recordRagUsage({ operation: "query", provider: "pinecone", tokensOut: recordCount });
}

/**
 * Convenience: record a Pinecone upsert.
 */
export function meterPineconeUpsert(recordCount: number): void {
  recordRagUsage({ operation: "upsert", provider: "pinecone", tokensOut: recordCount });
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Aggregate RAG usage grouped by (userId, operation, provider, model).
 */
export function getRagUsageSummary(opts: { sinceIso?: string } = {}): RagUsageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceIso) {
    where.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT user_id, operation, provider, model,
              COUNT(*) AS calls,
              COALESCE(SUM(tokens_in),0) AS tokens_in,
              COALESCE(SUM(tokens_out),0) AS tokens_out,
              COALESCE(SUM(batch_count),0) AS batch_count,
              COALESCE(SUM(cost_est_usd),0) AS cost_est_usd
       FROM rag_usage ${clause}
       GROUP BY user_id, operation, provider, model
       ORDER BY cost_est_usd DESC, calls DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.user_id),
    operation: r.operation as RagOperation,
    provider: String(r.provider),
    model: r.model == null ? null : String(r.model),
    calls: Number(r.calls),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    batchCount: Number(r.batch_count),
    costEstUsd: Number(r.cost_est_usd)
  }));
}
