/**
 * persist-candidate-pool (2026-07-06): persist the FULL retrieved candidate set — including
 * chunks that survived Pinecone recall but were later dropped by the score floor / as-of guard /
 * dedup, or simply didn't make the final top-`limit` slice — so "what did we retrieve but not
 * inject" is analyzable after the fact. Today only the post-selection top-N chunks that actually
 * reach a prompt get persisted (`ragAttributionsFromChunks` in socratic-runtime.ts slices to 5,
 * and `socraticRagAttributions` in strategy.ts is built from the already-final `context.chunks`).
 * The pre-slice candidate pool `rankPool` produces is otherwise discarded in-function.
 *
 * Flag-gated via RAG_PERSIST_CANDIDATE_POOL (default OFF, envFlagOn-parsed) — mirrors the
 * RAG_RETRIEVAL_TELEMETRY / recordRetrievalQuality precedent in rag-metering.ts: the flag check
 * happens BEFORE any work (no hashing, no mapping, no audit call) when off, so this is a true
 * no-op, not just a suppressed write, and default retrieval stays byte-for-byte unchanged.
 *
 * Deliberately NOT persisting raw chunk text (only ids/scores/asOf/docType/used) — the same
 * "never persist raw query text" posture `hashQuery` already established for
 * `recordRetrievalQuality`. A consumer that needs the text can join by id against the vector
 * store or the already-persisted attribution rows.
 */

import { audit } from "../db";
import { envFlagOn } from "./env-flag";

/** Returns true when RAG_PERSIST_CANDIDATE_POOL is truthy. Default OFF. */
export function candidatePoolPersistEnabled(): boolean {
  return envFlagOn("RAG_PERSIST_CANDIDATE_POOL", false);
}

export interface CandidatePoolEntry {
  id: string;
  /** Pinecone cosine similarity score. */
  score?: number;
  /** Voyage cross-encoder relevance score (`match._rerankScore`), when reranking ran. */
  relevanceScore?: number;
  /** metadata.doc_type, when present. */
  docType?: string;
  /** Resolved as-of/date stamp from metadata (acceptance_datetime / as_of / timestamp), when present. */
  asOf?: string;
  /** Whether this candidate survived into the final top-`limit` slice returned to the caller. */
  used: boolean;
}

export interface CandidatePoolRecord {
  /** Current strategy run id, when the caller has one (e.g. strategy.ts's per-run retrieval passes). */
  runId?: string;
  symbol: string;
  /** SHA-256 (first 16 hex) of the query — NEVER the raw query text (see hashQuery in rag-metering.ts). */
  queryHash: string;
  /** Point-in-time guard passed to this retrieval call, if any. */
  asOf?: string;
  candidates: CandidatePoolEntry[];
}

/**
 * Persist one candidate-pool record (fire-and-forget, never throws). No-ops entirely when
 * RAG_PERSIST_CANDIDATE_POOL is unset/off — callers are expected to gate the (cheap but
 * non-zero) mapping work at the call site too, but this function double-checks the flag so
 * calling it directly is always safe.
 */
export function recordCandidatePool(record: CandidatePoolRecord, userId: string = "local"): void {
  if (!candidatePoolPersistEnabled()) return;
  try {
    audit(
      "rag_candidate_pool",
      {
        runId: record.runId,
        symbol: record.symbol,
        queryHash: record.queryHash,
        asOf: record.asOf,
        candidateCount: record.candidates.length,
        candidates: record.candidates
      },
      userId
    );
  } catch {
    /* best-effort persistence only; never break retrieval */
  }
}
