import { Pinecone, type PineconeRecord, type RecordMetadata } from "@pinecone-database/pinecone";
import { VoyageAIClient } from "voyageai";
import crypto from "crypto";
import * as dbModule from "./db";
import { audit, getInternalSetting, resolveApiKey, setInternalSetting, type ApiKeySource } from "./db";
import { filterNewDocumentChunks, insertDocumentChunks } from "./db";
import { logApiHealth } from "./db-health";
import { CHARS_PER_TOKEN_CEILING, DEFAULT_MAX_TOKENS, canonicalTicker, chunkDocument, hashContent, type ChunkInput, type ChunkOptions } from "./rag/chunk";
import { envFlagOn } from "./rag/env-flag";
import { fuseHybrid, rrfFuse } from "./rag/hybrid";
import { dedupeSimilar, type DedupeSimilarReport } from "./rag/dedupe-similar";
import { getCachedQueryEmbedding, setCachedQueryEmbedding } from "./rag/query-embed-cache";
import { recordRagOperation, shouldDegradeForBudget } from "./rag/run-budget";
import { estimateVoyageDispatchCost, getRagUsageSummary, hashQuery, meterEmbed, meterPineconeQuery, meterPineconeUpsert, meterRerank, recordRetrievalQuality, retrievalTelemetryEnabled } from "./rag-metering";
import { candidatePoolPersistEnabled, recordCandidatePool, candidatePoolFullPersistEnabled, recordCandidatePoolFull, type CandidateDisposition } from "./rag/candidate-pool";
import { isOverLlmBudget } from "./llm-budget";
import { sendNotification } from "./notifications";
import { alertUsageLimitHit } from "./usage-limit-alerts";

const LAST_INGEST_KEY = "vectorStore:lastIngest";
const RAG_CONNECTION_ALERT_PREFIX = "vectorStore:connectionAlert";
const RAG_CONNECTION_ALERT_COOLDOWN_MS = 60 * 60_000;

/** Scope values written into vector metadata. New vectors carry this; legacy vectors lack it. */
export const SHARED_SCOPE = "shared" as const;
export const PRIVATE_SCOPE = "private" as const;
export type VectorScope = typeof SHARED_SCOPE | typeof PRIVATE_SCOPE;

export interface StoreContextsResult {
  /** Documents handed in (after trimming/empty-filter). */
  attempted: number;
  /** Records actually upserted into Pinecone. */
  indexed: number;
  /** Set when the embed/upsert flow threw (e.g. Voyage 429) — the failure is no longer silent. */
  error?: string;
  /** True when nothing was stored for a non-error reason — see unconfigured/dedupComplete for which. */
  skipped?: boolean;
  /** Set with skipped: Pinecone/Voyage keys missing — nothing can embed until configured. */
  unconfigured?: boolean;
  /** Set by opt-in `storeContexts` content dedup only. This proves reusable content exists, not that
   *  a new source occurrence has its own queryable vector; source producers must require
   *  `documentComplete` instead. `storeDocument` never returns this shortcut. */
  dedupComplete?: boolean;
  /**
   * Set by storeDocument only when every source occurrence has a successful Pinecone upsert plus
   * atomic document_chunks/chunk_occurrences receipts. Producers must require this and exact
   * indexed===attempted cardinality before writing a source-level completion ledger.
   */
  documentComplete?: boolean;
  /**
   * Count of malformed or unaccounted response entries detected by the integrity guard. Any positive
   * value rejects its entire Voyage batch, so callers can distinguish "nothing to embed" from an
   * incomplete/ambiguous provider response and keep the source document retryable.
   */
  rejectedInvalidEmbeddings?: number;
  /** Count skipped by RAG_INGEST_MAX_TEXTS_PER_DAY before any Voyage/Pinecone write. */
  budgetSkipped?: number;
  /** Count skipped by RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY before any Voyage/Pinecone write. */
  writeUnitBudgetSkipped?: number;
}

export interface VectorStoreStats {
  configured: boolean;
  indexName: string;
  exists?: boolean;
  totalVectorCount?: number;
  dimension?: number;
  error?: string;
}

export interface VectorIndexStats {
  indexName: string;
  totalVectorCount?: number;
  dimension?: number;
  error?: string;
}

// Using "voyage-finance-2" for high fidelity financial embeddings
const VOYAGE_MODEL = "voyage-finance-2";
/**
 * Embedding representation revision (2026-07-04 RAG quick-wins, builds on the composite review's
 * embed-model version-tag item). Bump this whenever the embedding-space representation changes in
 * a way that breaks direct cosine comparability against previously-indexed vectors — e.g. a
 * `VOYAGE_MODEL` swap, or flipping `VECTOR_EMBED_CLEAN_TEXT` (R17). Vectors written before this
 * item shipped carry no `embed_rev` at all; callers should treat a missing value as rev 0, NOT as
 * this rev, so a mixed population stays distinguishable.
 */
// Keep the live corpus on representation revision 1 until a bounded inventory/backfill,
// completeness check, switchover, rollback window, and v1 deletion can be executed. The prior
// dirty branch changed this globally to 2 without that migration, which mixed incomparable spaces.
const EMBED_REV = 1;
const EMBEDDING_DIMENSION = 1024; // voyage-finance-2 dimension
const DEFAULT_INDEX_NAME = "socratic-trade";
const DEFAULT_EMBED_BATCH_SIZE = 8;
const DEFAULT_EMBED_BATCH_DELAY_MS = 21_000; // unpaid Voyage limit is 3 RPM; paid accounts can set this to 0.
const DEFAULT_CONTEXT_MAX_CHARS = 2400;
const DEFAULT_EMBED_RETRY_ATTEMPTS = 2;
const DEFAULT_EMBED_RETRY_DELAY_MS = 20_000;
const DEFAULT_INGEST_MAX_TEXTS_PER_DAY = 20_000;
const DEFAULT_PINECONE_WRITE_UNITS_PER_DAY = 200_000;

/**
 * Embedding integrity guard (R2, 2026-07-01 expert review): a Voyage model/config drift (partial
 * response, NaN values) would otherwise upsert/query a degenerate vector that silently poisons
 * cosine scoring. Always-on (no flag) — it only ever REJECTS malformed data, never valid data.
 *
 * Deliberately checks non-emptiness + finiteness only, NOT strict equality to EMBEDDING_DIMENSION
 * (1024): many existing tests across this codebase use short illustrative mock embeddings (e.g.
 * `[0.1, 0.2]`) for readability, and a strict dimension check would reject all of them as "invalid"
 * even though they're perfectly fine test doubles, not production drift. A wrong-dimension response
 * from the REAL Voyage API would itself almost certainly also be empty/malformed in a way this still
 * catches; a hard 1024-only assertion is a follow-up if production evidence ever shows a same-length
 * garbage response slipping through.
 */
export function isValidEmbedding(embedding: unknown): embedding is number[] {
  return (
    Array.isArray(embedding) &&
    embedding.length > 0 &&
    embedding.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

export interface ValidatedDocumentEmbeddingBatch {
  /** Embeddings ordered by original request position; present only when the whole response is valid. */
  embeddings?: number[][];
  /** Number of malformed/unaccounted response entries; any positive value rejects the whole batch. */
  rejected: number;
  /** Bounded diagnostic code; never contains provider content or document text. */
  reason?: "missing-data" | "cardinality" | "malformed-item" | "mixed-index" | "invalid-index" | "duplicate-index" | "invalid-embedding";
}

/**
 * Validate Voyage's document response as an exact one-to-one mapping before any Pinecone write.
 * Explicit indices may arrive out of response-array order and are authoritative. A legacy response
 * with no indices remains positional, but mixed index presence is ambiguous and fails closed.
 */
export function validateDocumentEmbeddingBatch(
  data: unknown,
  expectedCount: number
): ValidatedDocumentEmbeddingBatch {
  if (!Array.isArray(data)) {
    return { rejected: Math.max(1, expectedCount), reason: "missing-data" };
  }
  if (data.length !== expectedCount) {
    return { rejected: Math.max(1, expectedCount), reason: "cardinality" };
  }

  const items: Array<{ embedding?: unknown; index?: unknown }> = [];
  let explicitIndexCount = 0;
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { rejected: Math.max(1, expectedCount), reason: "malformed-item" };
    }
    const item = raw as { embedding?: unknown; index?: unknown };
    if (item.index !== undefined) explicitIndexCount += 1;
    items.push(item);
  }
  if (explicitIndexCount !== 0 && explicitIndexCount !== expectedCount) {
    return { rejected: Math.max(1, expectedCount), reason: "mixed-index" };
  }

  const embeddings = new Array<number[]>(expectedCount);
  const seen = new Set<number>();
  let invalidEmbeddings = 0;
  for (let responsePosition = 0; responsePosition < items.length; responsePosition++) {
    const item = items[responsePosition]!;
    const targetIndex = explicitIndexCount === 0 ? responsePosition : item.index;
    if (!Number.isInteger(targetIndex) || (targetIndex as number) < 0 || (targetIndex as number) >= expectedCount) {
      return { rejected: Math.max(1, expectedCount), reason: "invalid-index" };
    }
    const requestIndex = targetIndex as number;
    if (seen.has(requestIndex)) {
      return { rejected: Math.max(1, expectedCount), reason: "duplicate-index" };
    }
    seen.add(requestIndex);
    if (!isValidEmbedding(item.embedding)) {
      invalidEmbeddings += 1;
      continue;
    }
    embeddings[requestIndex] = item.embedding;
  }
  if (invalidEmbeddings > 0 || embeddings.some((embedding) => !embedding)) {
    return { rejected: Math.max(1, invalidEmbeddings), reason: "invalid-embedding" };
  }
  return { embeddings, rejected: 0 };
}

export interface ContextDocument {
  text: string;
  /**
   * Optional exact text handed to Voyage while `text` remains the citation/display payload.
   * `storeDocument` uses raw chunk content here so occurrence-specific provenance stays in metadata
   * and citations without forcing byte-identical content to be embedded again for every ticker/date.
   */
  embeddingText?: string;
  metadata: { symbol: string; source: string; timestamp: string; accession?: string; [key: string]: unknown };
}

const DOCUMENT_EMBED_CACHE_MAX_ENTRIES = 4096;
const DOCUMENT_EMBED_CACHE_TTL_MS = 6 * 60 * 60_000;

interface DocumentEmbeddingCacheEntry {
  embedding: number[];
  expiresAt: number;
}

// Exact-text, vector-only, process-local cache. It never stores Pinecone results or metadata, so
// user/symbol/PIT filters still execute independently for every per-occurrence vector materialized.
const documentEmbeddingCache = new Map<string, DocumentEmbeddingCacheEntry>();

function documentEmbeddingCacheKey(input: string): string {
  // `input` is already the exact post-cleaning text, so model + representation revision + bytes is
  // sufficient and remains stable even if an operator changes an env flag while a call is in flight.
  return `${VOYAGE_MODEL}\u0000${EMBED_REV}\u0000${input}`;
}

function getCachedDocumentEmbedding(input: string): number[] | undefined {
  const key = documentEmbeddingCacheKey(input);
  const entry = documentEmbeddingCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt || !isValidEmbedding(entry.embedding)) {
    documentEmbeddingCache.delete(key);
    return undefined;
  }
  documentEmbeddingCache.delete(key);
  documentEmbeddingCache.set(key, entry);
  return [...entry.embedding];
}

function setCachedDocumentEmbedding(input: string, embedding: number[]): void {
  if (!isValidEmbedding(embedding)) return;
  const key = documentEmbeddingCacheKey(input);
  documentEmbeddingCache.delete(key);
  documentEmbeddingCache.set(key, {
    embedding: [...embedding],
    expiresAt: Date.now() + DOCUMENT_EMBED_CACHE_TTL_MS
  });
  while (documentEmbeddingCache.size > DOCUMENT_EMBED_CACHE_MAX_ENTRIES) {
    const oldest = documentEmbeddingCache.keys().next().value;
    if (oldest === undefined) break;
    documentEmbeddingCache.delete(oldest);
  }
}

/** Test-only cache reset; production callers never need to clear exact document vectors manually. */
export function clearDocumentEmbeddingCacheForTest(): void {
  documentEmbeddingCache.clear();
}

const indexInitPromises = new Map<string, Promise<void>>();

function indexName(): string {
  return process.env.PINECONE_INDEX_NAME || DEFAULT_INDEX_NAME;
}

function indexReadyWaitMs(): number {
  const parsed = Number(process.env.PINECONE_INDEX_READY_WAIT_MS ?? 5000);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

export function numericEnv(name: string, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Cosine-similarity floor applied at every retrieval call site unless the caller overrides it.
 *  Set VECTOR_MIN_SCORE=0 to disable the floor (restores the previous no-floor behavior). Default 0.30. */
export function defaultMinScore(): number {
  return numericEnv("VECTOR_MIN_SCORE", 0.3, 0, 1);
}

/**
 * Post-rerank relevance floor (2026-07-04 RAG quick-wins — "wire the dormant relevance-floor +
 * near-duplicate suppression stages"): `rankPool`/`RetrieveOptions.minRelevanceScore` have existed
 * since the 2026-07-01 backlog but no caller ever passed a value, so the Voyage cross-encoder floor
 * never ran in production. On rerank-2.5's relevance scale (distinct from Pinecone cosine `score`).
 * Set VECTOR_MIN_RELEVANCE_SCORE=0 to disable (restores pre-wiring behavior of no post-rerank
 * floor). Default 0.3 — the low end of the review's suggested 0.3-0.5 band, kept conservative so a
 * genuinely relevant chunk that reranks modestly isn't dropped before the floor is tuned on a
 * golden set.
 */
export function defaultRelevanceFloor(): number {
  return numericEnv("VECTOR_MIN_RELEVANCE_SCORE", 0.3, 0, 1);
}

/**
 * Near-duplicate suppression threshold (2026-07-04 RAG quick-wins, same item as
 * `defaultRelevanceFloor` above): `dedupeSimilar`/`RetrieveOptions.dedupeSimilarity` have existed
 * since the 2026-07-01 backlog but no caller ever passed a value, so the final top-K context could
 * be several near-identical restatements of one passage. Jaccard-shingle similarity (0-1); the
 * default is 0.6 per the review's suggested value.
 *
 * IMPORTANT: unlike `defaultMinScore`/`VECTOR_MIN_SCORE=0`, a threshold of literal `0` here is NOT
 * a safe "disable" value — `dedupeSimilar` treats `jaccardSimilarity(...) >= 0` as always true, so
 * threshold 0 would flag every subsequent non-empty chunk as a duplicate of the first one kept
 * (the opposite of disabling). Returns `undefined` — the actual "don't run dedup" sentinel
 * `RetrieveOptions.dedupeSimilarity`/`rankPool` already understand — when `VECTOR_DEDUPE_SIMILARITY`
 * resolves to <= 0, so an operator setting it to 0 to "turn dedup off" gets the behavior they
 * intended instead of a silently-broken threshold.
 */
export function defaultDedupeSimilarity(): number | undefined {
  const value = numericEnv("VECTOR_DEDUPE_SIMILARITY", 0.6, 0, 1);
  return value > 0 ? value : undefined;
}

function embedBatchSize(): number {
  return Math.floor(numericEnv("VECTOR_EMBED_BATCH_SIZE", DEFAULT_EMBED_BATCH_SIZE, 1, 128));
}

function embedBatchDelayMs(): number {
  return numericEnv("VECTOR_EMBED_BATCH_DELAY_MS", DEFAULT_EMBED_BATCH_DELAY_MS, 0);
}

function contextMaxChars(): number {
  return Math.floor(numericEnv("VECTOR_CONTEXT_MAX_CHARS", DEFAULT_CONTEXT_MAX_CHARS, 256));
}

function ingestBudgetEnabled(): boolean {
  return envFlagOn("RAG_INGEST_BUDGET_ENABLED", true);
}

function ingestMaxTextsPerDay(): number {
  return Math.floor(numericEnv("RAG_INGEST_MAX_TEXTS_PER_DAY", DEFAULT_INGEST_MAX_TEXTS_PER_DAY, 1));
}

function remainingIngestTexts(userId: string, requested: number): { allowed: number; used: number; limit: number } {
  const limit = ingestMaxTextsPerDay();
  if (!ingestBudgetEnabled()) return { allowed: requested, used: 0, limit };
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const used = getRagUsageSummary({ sinceIso })
      .filter((row) => row.userId === userId && row.provider === "voyage" && row.operation === "embed")
      .reduce((sum, row) => sum + row.batchCount, 0);
    return { allowed: Math.max(0, Math.min(requested, limit - used)), used, limit };
  } catch {
    // Tests mock db.ts without the usage table; fail open there instead of breaking vector mocks.
    return { allowed: requested, used: 0, limit };
  }
}

/** Whether the rolling-24h ingest text budget (RAG_INGEST_MAX_TEXTS_PER_DAY) has any headroom
 *  left for this user scope. Cheap pre-flight for bulk ingest loops (SEC filings): checking
 *  BEFORE fetching/chunking a document avoids downloading multi-MB filing bodies that
 *  storeDocument would only budget-skip — and avoids emitting one budget warning per doomed
 *  document. Fails open (true) when the budget is disabled or unreadable, mirroring
 *  remainingIngestTexts. */
export function hasIngestTextBudget(userId: string = "local"): boolean {
  return remainingIngestTexts(userId, 1).allowed > 0;
}

function pineconeWriteBudgetEnabled(): boolean {
  return envFlagOn("RAG_PINECONE_WRITE_BUDGET_ENABLED", true);
}

function pineconeMaxWriteUnitsPerDay(): number {
  return Math.floor(numericEnv("RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY", DEFAULT_PINECONE_WRITE_UNITS_PER_DAY, 1));
}

function usedPineconeWriteUnitsLast24h(userId: string): number {
  if (!pineconeWriteBudgetEnabled()) return 0;
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    return getRagUsageSummary({ sinceIso })
      .filter((row) => row.userId === userId && row.provider === "pinecone" && row.operation === "upsert")
      .reduce((sum, row) => {
        // New rows store estimated WUs in tokensIn. Older rows only stored record count in
        // tokensOut; charge them at 5 WUs/record so legacy history still throttles runaway writes.
        return sum + (row.tokensIn > 0 ? row.tokensIn : row.tokensOut * 5);
      }, 0);
  } catch {
    // Tests mock db.ts without the usage table; fail open there instead of breaking vector mocks.
    return 0;
  }
}

function estimatePineconeRecordWriteUnits(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 1024));
}

function pineconeMetadataBytes(metadata: RecordMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

function embedRetryAttempts(): number {
  return Math.floor(numericEnv("VECTOR_EMBED_RETRY_ATTEMPTS", DEFAULT_EMBED_RETRY_ATTEMPTS, 0, 5));
}

function embedRetryDelayMs(): number {
  return numericEnv("VECTOR_EMBED_RETRY_DELAY_MS", DEFAULT_EMBED_RETRY_DELAY_MS, 0);
}

// Voyage reranking: the single biggest retrieval-quality lever. We over-fetch from Pinecone (cheap
// cosine recall) then have Voyage's cross-encoder reranker reorder by true query relevance. ON by
// default; set VECTOR_ENABLE_RERANK=off to disable. Fails safe to cosine order on any error.
const DEFAULT_RERANK_MODEL = "rerank-2.5";
function rerankEnabled(): boolean {
  // Rerank is opt-OUT (default true), unlike every other RAG flag which is opt-in (default
  // false) — so this can't route through envFlagOn's truthy-set/default_ shape directly. Keep
  // its own off-set check, but reuse envFlagOn's accepted vocabulary so "off"/"no"/"false"/"0"
  // stay consistent across every RAG flag in this file.
  const v = String(process.env.VECTOR_ENABLE_RERANK ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}
function rerankModel(): string {
  return process.env.VOYAGE_RERANK_MODEL || DEFAULT_RERANK_MODEL;
}
/** How many candidates to pull from Pinecone before as-of filtering (non-rerank path) down to `limit`. */
function overFetchK(limit: number): number {
  return Math.min(Math.max(limit * 5, limit), 50);
}

/**
 * Rerank-path candidate-pool cap (2026-07-04 RAG quick-wins, composite review "raise the rerank
 * candidate-pool cap"). `overFetchK` hard-capped every over-fetch path (rerank, hybrid, as-of) at
 * 50, but `rerank-2.5` can cross-encode hundreds-to-1000 candidates cheaply — for a mega-cap with a
 * full 10-K plus many 8-Ks, the flip-the-decision chunk at dense rank 51+ never reached the
 * reranker. Env-tunable via VECTOR_RERANK_OVERFETCH_K (default 150); ONLY widens the pool actually
 * handed to reranking. The non-rerank overfetch paths (as-of-only, hybrid-without-rerank) keep the
 * existing modest `overFetchK` cap — this does not change their Pinecone topK.
 */
const DEFAULT_RERANK_OVERFETCH_K = 150;
function rerankOverFetchK(limit: number): number {
  const cap = Math.floor(numericEnv("VECTOR_RERANK_OVERFETCH_K", DEFAULT_RERANK_OVERFETCH_K, 1));
  return Math.max(limit, cap);
}

/** Hybrid dense+BM25 retrieval via Reciprocal Rank Fusion. OFF by default — set HYBRID_RETRIEVAL=on to enable.
 *  When OFF, the retrieval path is byte-for-byte the current dense-only flow. */
function hybridRetrievalEnabled(): boolean {
  return envFlagOn("HYBRID_RETRIEVAL", false);
}

/**
 * R1 strict as-of mode (2026-07-01 expert-review follow-up, item R1 part 2). OFF by default — set
 * VECTOR_ASOF_STRICT=on to enable. When ON *and* the caller passed `options.asOf`, the retrieval
 * pipeline DROPS chunks with no resolvable date stamp (after the acceptance_datetime ->
 * published_at -> as_of -> timestamp chain `isWithinAsOf` already resolves) instead of the lenient
 * default of keeping them. Never changes behavior when `asOf` is unset (the chat default — no
 * point-in-time guard active at all) or when this flag is off, so default retrieval is unaffected.
 */
export function asOfStrictEnabled(): boolean {
  return envFlagOn("VECTOR_ASOF_STRICT", false);
}

/**
 * server-asof-filter (2026-07-06): push the point-in-time (`asOf`) constraint INTO the Pinecone
 * query so `topK` is filled with ELIGIBLE (pre-asOf) candidates, instead of the current behavior
 * where the pure-vector top-K is dominated by too-recent filings that the POST-fetch `isWithinAsOf`
 * guard then decimates — leaving a tiny/empty pool in a backtest even though the correct older
 * filings exist in the corpus (ranked below the fetch window).
 *
 * OFF by default — set VECTOR_ASOF_SERVER_FILTER=on to enable. It is safe to turn on at any time on
 * the DEFAULT (fail-open) semantics because the server clause keeps un-epoch'd vectors (see
 * `buildAsOfEpochFilter`), so an un-backfilled corpus is NOT dropped; running the backfill first
 * just makes the topK-fill improvement effective for older vectors too. When OFF, the retrieval
 * path is byte-for-byte the current post-fetch-only behavior.
 *
 * DEFENSE IN DEPTH: this NEVER removes the post-fetch `isWithinAsOf` guard in `rankPool` — that
 * stays the authoritative leakage gate regardless of this flag. Server filtering only pre-fills a
 * better candidate pool; the post-fetch guard is what actually enforces no-lookahead.
 */
export function asOfServerFilterEnabled(): boolean {
  return envFlagOn("VECTOR_ASOF_SERVER_FILTER", false);
}

/**
 * server-asof-filter (2026-07-06): build the Pinecone metadata-filter clause that pushes the `asOf`
 * epoch constraint server-side. Returns `undefined` when it should add NO clause (asOf unset/
 * unparseable, or the server-filter flag off) so the caller's existing filter is byte-identical to
 * today. Otherwise returns a single clause to AND-combine with the existing docType/symbol/scope
 * filter.
 *
 * Semantics (owner-approved):
 *  - FAIL-OPEN (default, `strict=false`): keep epoch'd-AND-eligible vectors OR vectors LACKING the
 *    epoch field, via `$or: [{as_of_epoch_ms: {$lte: X}}, {as_of_epoch_ms: {$exists: false}}]`, so
 *    an un-backfilled/undated corpus is NOT dropped server-side. The post-fetch `isWithinAsOf` guard
 *    remains the real leakage gate. `$exists` is a documented Pinecone metadata operator; the JS
 *    client (v8) types `filter` as an opaque `object` and forwards it verbatim, so this composes
 *    cleanly (verified in node_modules — see the server-asof-filter rollout note).
 *  - FAIL-CLOSED (`strict=true`, VECTOR_ASOF_STRICT on): drop un-epoch'd vectors server-side with a
 *    plain `{as_of_epoch_ms: {$lte: X}}` (no `$exists` branch) — only epoch'd-and-eligible return.
 *    Composes with the existing post-fetch strict undated-drop for leakage-certified backtests.
 */
export function buildAsOfEpochFilter(asOf: string | undefined, strict: boolean): Record<string, unknown> | undefined {
  if (!asOf || !asOfServerFilterEnabled()) return undefined;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return undefined; // unparseable asOf -> no server constraint (matches isWithinAsOf's lenient short-circuit)
  const eligible = { [AS_OF_EPOCH_FIELD]: { $lte: asOfMs } };
  if (strict) return eligible; // fail-closed: epoch'd-and-eligible only
  // fail-open: epoch'd-and-eligible OR un-epoch'd (absent field)
  return { $or: [eligible, { [AS_OF_EPOCH_FIELD]: { $exists: false } }] };
}

/**
 * server-asof-filter (2026-07-06): AND-combine a base Pinecone metadata filter with the optional
 * server-side `asOf` epoch clause. Returns the base UNCHANGED (same object) when there is no epoch
 * clause, so a call with `epoch === undefined` is byte-identical to not calling this at all.
 *
 * When an epoch clause IS present it merges via `$and: [base, epoch]` rather than spreading epoch's
 * keys onto the base. This is REQUIRED for correctness, not stylistic: the fail-open epoch clause is
 * itself `{$or: [...]}`, and the shared-tier base filter ALSO carries a top-level `$or` (scope/userId
 * coexistence) — a spread would silently drop one `$or` (a JS object can't hold two identical keys),
 * changing which vectors match. `$and` keeps both intact and is the documented Pinecone way to
 * combine independent constraints. The base is not mutated (a fresh object is returned).
 */
export function mergeAsOfEpoch(
  base: Record<string, unknown>,
  epoch: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!epoch) return base;
  return { $and: [base, epoch] };
}

/**
 * Every query excludes managed pending records at Pinecone. Legacy records are admitted only when
 * the receipt marker is absent; direct new records explicitly carry receipt_required=false.
 */
export function withCommittedVectorFilter(base: Record<string, unknown>): Record<string, unknown> {
  return {
    $and: [
      base,
      {
        $or: [
          { receipt_required: { $exists: false } },
          { receipt_required: { $eq: false } },
          { ingest_state: { $eq: "committed" } }
        ]
      }
    ]
  };
}

/**
 * R17 (2026-07-01 RAG backlog): fix train/serve text skew. `storeContexts` embeds a literal
 * `[Published: ...]` prefix (and `storeDocument` bakes a `context_header` into stored text), but
 * the QUERY embedding is the raw query with none of that boilerplate — a systematic query/document
 * skew in Voyage's embedding space that dilutes what the cosine floor actually measures.
 *
 * When ON, `storeContexts` embeds CLEAN text (provenance boilerplate stripped) while the STORED
 * metadata text (used for citations/display) is unchanged — `matchToChunk` already reads
 * `acceptance_datetime`/`timestamp` from metadata directly, so no retrieval-side behavior depends
 * on the boilerplate being embedded.
 *
 * Default OFF: flipping this changes the embedding-space representation of every NEWLY-indexed
 * vector, so it invalidates direct comparability against vectors indexed before the flag was
 * enabled (a full reindex is the clean way to move the whole corpus onto one representation —
 * see the rollout note for the decision on transitional mixed-representation vs scheduled reindex).
 */
export function embedCleanTextEnabled(): boolean {
  return envFlagOn("VECTOR_EMBED_CLEAN_TEXT", false);
}

/**
 * Strip the `[Published: YYYY-MM-DD] ` boilerplate prefix `storeContexts` prepends, if present.
 * Pure string operation — used ONLY to build the text handed to Voyage for embedding when
 * `VECTOR_EMBED_CLEAN_TEXT` is on; the stored/cited text is never modified by this.
 */
export function stripPublishedPrefix(text: string): string {
  return text.replace(/^\[Published: \d{4}-\d{2}-\d{2}\]\s*/, "");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
  }
  if (ms <= 0) return Promise.resolve();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * Sanitizes user IDs to prevent injection attacks and ensure query stability.
 * Allows alphanumeric, dashes, underscores, dots, and '@'. Caps at 100 characters.
 */
export function sanitizeUserId(userId?: string): string {
  if (!userId) return "local";
  const sanitized = userId.trim().replace(/[^a-zA-Z0-9_\-.@]/g, "");
  if (!sanitized) return "local";
  return sanitized.slice(0, 100);
}

/**
 * Ensures we have valid clients for Pinecone and Voyage. Clients are memoized per resolved
 * key-pair (not per userId, so a key rotation naturally yields a fresh client) to avoid
 * constructing a new SDK client on every embed/query/rerank call.
 */
const clientCache = new Map<string, { pc: Pinecone; voyage: VoyageAIClient }>();

function resolveRagKeyWithSource(service: "pinecone" | "voyage", userId: string): { key?: string; source: ApiKeySource; envVar?: string; service: string } {
  let sourceAwareResolver: ((service: "pinecone" | "voyage", userId?: string) => { key?: string; source: ApiKeySource; envVar?: string; service: string }) | undefined;
  try {
    const candidate = (dbModule as Record<string, unknown>).resolveApiKeyWithSource;
    if (typeof candidate === "function") sourceAwareResolver = candidate as typeof sourceAwareResolver;
  } catch {
    // Older isolated tests mock only resolveApiKey; fall through to the legacy resolver.
  }
  if (sourceAwareResolver) return sourceAwareResolver(service, userId);
  const key = resolveApiKey(service, userId);
  return { key, source: key ? "env" : "none", service };
}

async function getClients(userId: string = "local", leaseGuard?: VectorStoreLeaseGuard) {
  assertVectorStoreLease(leaseGuard);
  const lookupUserId = userId || "local";
  const pinecone = resolveRagKeyWithSource("pinecone", lookupUserId);
  const voyage = resolveRagKeyWithSource("voyage", lookupUserId);
  const pineconeKey = pinecone.key;
  const voyageKey = voyage.key;

  if (!pineconeKey || !voyageKey) {
    if (leaseGuard) {
      if (!pineconeKey) {
        await recordMissingRagKey("pinecone", pinecone.source, lookupUserId, pinecone.envVar, leaseGuard);
        assertVectorStoreLease(leaseGuard);
      }
      if (!voyageKey) {
        await recordMissingRagKey("voyage", voyage.source, lookupUserId, voyage.envVar, leaseGuard);
        assertVectorStoreLease(leaseGuard);
      }
    } else {
      if (!pineconeKey) void recordMissingRagKey("pinecone", pinecone.source, lookupUserId, pinecone.envVar).catch(() => {});
      if (!voyageKey) void recordMissingRagKey("voyage", voyage.source, lookupUserId, voyage.envVar).catch(() => {});
    }
    return { pc: null, voyage: null, initCacheKey: "", pineconeSource: pinecone.source, voyageSource: voyage.source };
  }

  const cacheKey = `${pineconeKey}|${voyageKey}`;
  let clients = clientCache.get(cacheKey);
  if (!clients) {
    assertVectorStoreLease(leaseGuard);
    clients = { pc: new Pinecone({ apiKey: pineconeKey }), voyage: new VoyageAIClient({ apiKey: voyageKey }) };
    clientCache.set(cacheKey, clients);
  }

  return {
    pc: clients.pc,
    voyage: clients.voyage,
    initCacheKey: `${pineconeKey}:${indexName()}`,
    pineconeSource: pinecone.source,
    voyageSource: voyage.source
  };
}

function ragHealthUserId(source: ApiKeySource, userId: string): string {
  return source === "user" ? sanitizeUserId(userId) : "local";
}

function ragErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ragLimitStatus(message: string): "rate_limited" | "billing" | "quota" | undefined {
  if (/\b429\b|rate limit|too many requests|RPM|TPM/i.test(message)) return "rate_limited";
  if (/billing|payment|invoice|past due|upgrade|plan/i.test(message)) return "billing";
  if (/quota|write units?|read units?|usage limit|capacity|exceeded|paused/i.test(message)) return "quota";
  return undefined;
}

function markRagSentryCaptured(error: unknown): void {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, "__ragSentryCaptured", {
      value: true,
      configurable: true
    });
  } catch {
    try {
      (error as { __ragSentryCaptured?: boolean }).__ragSentryCaptured = true;
    } catch {
      // best-effort marker only
    }
  }
}

function wasRagSentryCaptured(error: unknown): boolean {
  return Boolean((error as { __ragSentryCaptured?: boolean } | undefined)?.__ragSentryCaptured);
}

async function recordMissingRagKey(
  service: "pinecone" | "voyage",
  source: ApiKeySource,
  userId: string,
  envVar?: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  const message = envVar ? `${envVar} is not configured` : `${service} API key is not configured`;
  const targetUserId = ragHealthUserId(source, userId);
  assertVectorStoreLease(leaseGuard);
  logApiHealth({
    service,
    ok: false,
    errorText: message,
    keySource: source,
    userId: targetUserId
  });
  assertVectorStoreLease(leaseGuard);
  await alertRagConnectionFailure(service, source, targetUserId, "configuration", message, leaseGuard);
  assertVectorStoreLease(leaseGuard);
}

async function alertRagConnectionFailure(
  service: "pinecone" | "voyage" | "voyage-rerank",
  source: ApiKeySource,
  targetUserId: string,
  operation: string,
  message: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  try {
    const assertActive = leaseGuard ? () => assertVectorStoreLease(leaseGuard) : undefined;
    assertVectorStoreLease(leaseGuard);
    const key = `${RAG_CONNECTION_ALERT_PREFIX}:${service}:${source}:${targetUserId}`;
    const last = getInternalSetting<string>(key);
    if (last && Date.now() - Date.parse(last) < RAG_CONNECTION_ALERT_COOLDOWN_MS) return;
    assertVectorStoreLease(leaseGuard);
    setInternalSetting(key, new Date().toISOString());

    const title = `${service === "pinecone" ? "Pinecone" : service === "voyage-rerank" ? "Voyage Rerank" : "Voyage"} connection failed`;
    const body = `${operation}: ${message}`;
    const payload = {
      provider: service,
      source,
      operation,
      reason: message,
      userSpecific: source === "user"
    };
    await captureRagSentryMessage("warning", title, {
      provider: service,
      source,
      operation,
      userSpecific: source === "user",
      reason: message
    }, leaseGuard);
    assertVectorStoreLease(leaseGuard);
    await sendNotification(
      { type: "provider_degraded", title, payload },
      { userId: targetUserId, directBody: body, assertActive, signal: leaseGuard?.signal }
    );
    assertVectorStoreLease(leaseGuard);
    const limitStatus = ragLimitStatus(message);
    if (limitStatus) {
      await alertUsageLimitHit(
        {
          userId: targetUserId,
          provider: title.replace(" connection failed", ""),
          operation,
          limitName: limitStatus === "rate_limited" ? "provider rate limit" : limitStatus === "billing" ? "provider billing limit" : "provider quota",
          status: limitStatus,
          recommendation:
            limitStatus === "rate_limited"
              ? "Either slow the caller, batch requests more efficiently, or raise the provider rate limit if the traffic is intentional."
              : "Check whether this is expected growth. If usage is useful, raise the cap; if not, inspect batching, deduping, and retry behavior before paying for more."
        },
        { assertActive, signal: leaseGuard?.signal }
      );
      assertVectorStoreLease(leaseGuard);
    }
  } catch (error) {
    if (error instanceof VectorStoreLeaseLostError) throw error;
    // Alerts must not affect trading/RAG control flow.
  }
}

async function captureRagSentryMessage(
  level: "warning" | "error",
  message: string,
  context: Record<string, string | number | boolean | null | undefined>,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  if (!process.env.SENTRY_DSN) return;
  try {
    const mod = (await import("@sentry/nextjs")) as typeof import("@sentry/nextjs") & {
      default?: typeof import("@sentry/nextjs");
    };
    assertVectorStoreLease(leaseGuard);
    const captureMessage = mod.captureMessage ?? mod.default?.captureMessage;
    const withScope = mod.withScope ?? mod.default?.withScope;
    if (typeof captureMessage !== "function" || typeof withScope !== "function") return;
    assertVectorStoreLease(leaseGuard);
    withScope((scope) => {
      scope.setLevel(level);
      scope.setTag("component", "rag");
      if (context.provider) scope.setTag("rag.provider", String(context.provider));
      if (context.operation) scope.setTag("rag.operation", String(context.operation));
      if (context.source) scope.setTag("rag.key_source", String(context.source));
      scope.setContext("rag", context);
      captureMessage(message);
    });
    assertVectorStoreLease(leaseGuard);
  } catch (error) {
    if (error instanceof VectorStoreLeaseLostError) throw error;
    // Observability must not affect trading/RAG control flow.
  }
}

interface RagDispatchOptions {
  units?: number;
  estimatedCostUsd?: number;
  /** The callback reserves each physical retry itself (used by Voyage's explicit retry loop). */
  durablyTrackedInside?: boolean;
}

async function withDurableRagProviderDispatch<T>(
  service: "pinecone" | "voyage" | "voyage-rerank",
  source: ApiKeySource,
  userId: string,
  operation: string,
  fn: () => Promise<T>,
  leaseGuard?: VectorStoreLeaseGuard,
  dispatch?: RagDispatchOptions
): Promise<T> {
  assertVectorStoreLease(leaseGuard);
  const provider = service === "voyage-rerank" ? "voyage" : service;
  const credential = resolveApiKey(provider, userId) ?? `${provider}:${source}:${userId}`;
  const credentialRef = crypto.createHash("sha256").update(credential, "utf8").digest("hex").slice(0, 24);
  const perMinuteDefault = provider === "voyage" ? 60 : 600;
  const envPrefix = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const perMinuteRaw = process.env[`PROVIDER_DISPATCH_${envPrefix}_PER_MIN`]?.trim();
  const costCapRaw = process.env[`PROVIDER_DISPATCH_${envPrefix}_MAX_COST_USD_PER_DAY`]?.trim();
  const configuredPerMinute = perMinuteRaw ? Number(perMinuteRaw) : undefined;
  const configuredCostCap = costCapRaw ? Number(costCapRaw) : undefined;
  let attemptId: string | undefined;
  let providerSettled = false;
  let providerReturned = false;
  let markDispatch: typeof dbModule.markProviderDispatchStarted | undefined;
  let settleDispatch: typeof dbModule.settleProviderDispatch | undefined;
  try {
    const reserveDispatch = dbModule.reserveProviderDispatch;
    markDispatch = dbModule.markProviderDispatchStarted;
    settleDispatch = dbModule.settleProviderDispatch;
    if (
      typeof reserveDispatch !== "function" ||
      typeof markDispatch !== "function" ||
      typeof settleDispatch !== "function"
    ) throw new Error("Durable provider dispatch ledger is unavailable.");
    const reservation = reserveDispatch({
      provider,
      operation,
      credentialRef,
      userId,
      units: dispatch?.units ?? 1,
      estimatedCostUsd: dispatch?.estimatedCostUsd ?? 0,
      windows: [{
        // Explicit zero pauses this provider lane. Empty/unset/invalid values retain the safe
        // default instead of Number("") accidentally becoming a production stop.
        maxUnits: typeof configuredPerMinute === "number" && Number.isFinite(configuredPerMinute) && configuredPerMinute >= 0
          ? Math.floor(configuredPerMinute)
          : perMinuteDefault,
        windowMs: 60_000
      }],
      // A configured zero is a deliberate stop. When unset, $25/day is a conservative shared
      // dispatch fuse; request/text/WU budgets remain the tighter normal controls.
      maxEstimatedCostUsdPer24h: typeof configuredCostCap === "number" && Number.isFinite(configuredCostCap) && configuredCostCap >= 0
        ? configuredCostCap
        : 25
    });
    if (!reservation.admitted) throw new Error(`Durable ${provider} ${reservation.reason} reservation denied.`);
    attemptId = reservation.attemptId;
  } catch (error) {
    // A few isolated unit suites replace the entire db module with a minimal fake. Never permit
    // that seam outside tests; production must fail closed if the durable admission ledger fails.
    const missingTestMock = process.env.NODE_ENV === "test" && error instanceof Error && (
      error.message === "Durable provider dispatch ledger is unavailable." ||
      /No \"(?:reserveProviderDispatch|markProviderDispatchStarted|settleProviderDispatch)\" export is defined .* mock/i.test(error.message)
    );
    if (!missingTestMock) throw error;
    markDispatch = undefined;
    settleDispatch = undefined;
  }
  try {
    if (attemptId) markDispatch!(attemptId);
    const result = await fn();
    providerReturned = true;
    // Usage truth is independent of the business lease. Settle before checking whether ownership
    // moved while the SDK promise was in flight.
    if (attemptId) settleDispatch!(attemptId, "succeeded");
    providerSettled = true;
    assertVectorStoreLease(leaseGuard);
    return result;
  } catch (error) {
    if (attemptId && !providerSettled && !providerReturned) settleDispatch!(attemptId, "failed", {
      outcomeCode: error instanceof Error ? error.name : "provider-error"
    });
    throw error;
  }
}

async function withRagApiHealth<T>(
  service: "pinecone" | "voyage" | "voyage-rerank",
  source: ApiKeySource,
  userId: string,
  operation: string,
  fn: () => Promise<T>,
  leaseGuard?: VectorStoreLeaseGuard,
  dispatch?: RagDispatchOptions
): Promise<T> {
  assertVectorStoreLease(leaseGuard);
  const start = Date.now();
  const targetUserId = ragHealthUserId(source, userId);
  try {
    const result = dispatch?.durablyTrackedInside
      ? await fn()
      : await withDurableRagProviderDispatch(
          service,
          source,
          userId,
          operation,
          fn,
          leaseGuard,
          dispatch
        );
    assertVectorStoreLease(leaseGuard);
    logApiHealth({
      service,
      ok: true,
      latencyMs: Date.now() - start,
      keySource: source,
      userId: targetUserId
    });
    return result;
  } catch (error) {
    // Lease cancellation is a concurrency boundary, not provider degradation. The caller converts
    // it to VectorStoreLeaseLostError and must not emit health failures/alerts for the successor's
    // operation.
    assertVectorStoreLease(leaseGuard);
    const message = `${operation}: ${ragErrorMessage(error)}`;
    assertVectorStoreLease(leaseGuard);
    logApiHealth({
      service,
      ok: false,
      latencyMs: Date.now() - start,
      errorText: message,
      keySource: source,
      userId: targetUserId
    });
    markRagSentryCaptured(error);
    const alert = alertRagConnectionFailure(service, source, targetUserId, operation, ragErrorMessage(error), leaseGuard);
    if (leaseGuard) {
      await alert;
      assertVectorStoreLease(leaseGuard);
    } else {
      void alert;
    }
    throw error;
  }
}

// R7 (2026-07-01 RAG backlog): cache of already-asserted index metrics, keyed the same way as
// indexInitPromises, so `describeIndex` is called AT MOST ONCE per (key, index) pair for the
// lifetime of the process — not once per retrieval/store call.
const indexMetricChecked = new Set<string>();
const initializedIndexKeys = new Set<string>();

/**
 * R7 — index-metric assertion at bootstrap. Every cosine floor (VECTOR_MIN_SCORE, the rerank
 * relevance floor) is meaningless if the Pinecone index's distance metric isn't actually
 * 'cosine' — EMBEDDING_DIMENSION is asserted (createIndex specifies it), but the metric never
 * was. Calls `describeIndex` once (cached via indexMetricChecked) and WARNS (audit + console),
 * NEVER throws for provider/metric failures — a legitimate non-cosine index or transient
 * control-plane failure must not take down retrieval/storage. Durable lease loss still propagates.
 */
async function assertIndexMetric(
  pc: Pinecone,
  initCacheKey: string,
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  if (indexMetricChecked.has(initCacheKey)) return;
  try {
    const model = await withRagApiHealth(
      "pinecone",
      source,
      userId,
      "describeIndex",
      () => pc.describeIndex(indexName()),
      leaseGuard
    );
    assertVectorStoreLease(leaseGuard);
    const metric = (model as { metric?: unknown })?.metric;
    if (metric != null && metric !== "cosine") {
      assertVectorStoreLease(leaseGuard);
      console.warn(`[vector-db] Pinecone index "${indexName()}" metric is "${String(metric)}", expected "cosine" — cosine-scale floors (VECTOR_MIN_SCORE, rerank relevance floor) may be meaningless against this index.`);
      await captureRagSentryMessage("warning", "Pinecone index metric mismatch", {
        provider: "pinecone",
        operation: "describeIndex",
        source,
        indexName: indexName(),
        metric: String(metric),
        expectedMetric: "cosine"
      }, leaseGuard);
      assertVectorStoreLease(leaseGuard);
      try {
        audit("vector_index_metric_mismatch", { indexName: indexName(), metric: String(metric) }, "local");
      } catch {
        // best-effort audit only
      }
    }
  } catch (err) {
    // A stale owner must not turn cancellation into a best-effort warning, Sentry alert, or cached
    // "metric checked" receipt. The successor gets an independent initialization attempt.
    assertVectorStoreLease(leaseGuard);
    // describeIndex itself failing (network, permissions, index not found yet) is NOT the
    // condition this guard checks for — swallow silently, this is a best-effort sanity check.
    console.warn(`[vector-db] Could not verify index metric for "${indexName()}":`, err instanceof Error ? err.message : String(err));
    await captureRagSentryMessage("warning", "Pinecone index metric check failed", {
      provider: "pinecone",
      operation: "describeIndex",
      source,
      indexName: indexName(),
      reason: err instanceof Error ? err.message : String(err)
    }, leaseGuard);
  }
  assertVectorStoreLease(leaseGuard);
  // Mark only after the complete guarded path. A lease-aborted attempt must remain retryable.
  indexMetricChecked.add(initCacheKey);
}

async function initializeIndex(
  pc: Pinecone,
  initCacheKey: string,
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  const name = indexName();
  const indexes = await withRagApiHealth(
    "pinecone",
    source,
    userId,
    "listIndexes",
    () => pc.listIndexes(),
    leaseGuard
  );
  assertVectorStoreLease(leaseGuard);
  if (!indexes.indexes?.some((i) => i.name === name)) {
    try {
      await withRagApiHealth(
        "pinecone",
        source,
        userId,
        "createIndex",
        () => pc.createIndex({
          name,
          dimension: EMBEDDING_DIMENSION,
          metric: "cosine",
          spec: { serverless: { cloud: "aws", region: "us-east-1" } }
        }),
        leaseGuard
      );
    } catch (error) {
      assertVectorStoreLease(leaseGuard);
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|409|conflict/i.test(message)) throw error;
    }
    assertVectorStoreLease(leaseGuard);
    await sleep(indexReadyWaitMs(), leaseGuard?.signal);
    assertVectorStoreLease(leaseGuard);
  }
  await assertIndexMetric(pc, initCacheKey, source, userId, leaseGuard);
  assertVectorStoreLease(leaseGuard);
}

async function ensureIndex(
  pc: Pinecone,
  initCacheKey: string,
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  if (initializedIndexKeys.has(initCacheKey)) return;

  // Never attach a durable owner to another owner's in-flight cached promise. Guarded producers are
  // serialized by RAG_REINDEX and initialize independently; only a fully completed result is shared.
  if (leaseGuard) {
    await initializeIndex(pc, initCacheKey, source, userId, leaseGuard);
    assertVectorStoreLease(leaseGuard);
    initializedIndexKeys.add(initCacheKey);
    return;
  }

  const cached = indexInitPromises.get(initCacheKey);
  if (cached) return cached;

  const init = initializeIndex(pc, initCacheKey, source, userId);

  indexInitPromises.set(initCacheKey, init);
  try {
    await init;
    initializedIndexKeys.add(initCacheKey);
  } catch (error) {
    indexInitPromises.delete(initCacheKey);
    throw error;
  }
}

async function indexExists(pc: Pinecone, source: ApiKeySource, userId: string): Promise<boolean> {
  const indexes = await withRagApiHealth("pinecone", source, userId, "listIndexes", () => pc.listIndexes());
  return Boolean(indexes.indexes?.some((i) => i.name === indexName()));
}

/**
 * server-asof-filter (2026-07-06): the numeric point-in-time metadata field written on every
 * newly-upserted vector so a backtest's `asOf` constraint can be pushed INTO the Pinecone query
 * (server-side) instead of only being applied POST-fetch. Integer epoch milliseconds. Deliberately
 * numeric (not the ISO string in `acceptance_datetime`) because Pinecone's `$lte`/`$gte` range
 * operators only work against numbers — an ISO-string range filter isn't expressible server-side.
 *
 * ABSENCE is meaningful: a vector that lacks this field is UNDATED-for-server-purposes and is the
 * fail-open signal (see `retrieveContextDetailed`'s epoch clause). It is ONLY written when a date
 * actually resolves, so an un-backfilled/undated vector stays absent and is not falsely dated to 0.
 */
export const AS_OF_EPOCH_FIELD = "as_of_epoch_ms" as const;

/**
 * Derive the numeric point-in-time epoch (ms) for a vector's metadata using the SAME precedence
 * `resolveAsOfStamp`/`isWithinAsOf` use: acceptance_datetime -> published_at -> as_of -> timestamp.
 * Returns `undefined` when none of those keys is present/parseable (NaN-safe) — callers MUST treat
 * `undefined` as "leave the field absent" so absence stays the fail-open signal. Pure/dependency-free
 * so both the ingest write path (`cleanMetadata`) and the backfill path can share one source of truth.
 *
 * NOTE: this intentionally mirrors `resolveAsOfStamp` exactly. It is a separate function only so it
 * can be co-located with the write path (`cleanMetadata` is defined above `resolveAsOfStamp`) and so
 * its "absent means fail-open" contract is documented at the point the field is written.
 */
export function resolveAsOfEpochMs(metadata: Record<string, unknown> | undefined): number | undefined {
  const stamp = metadata?.acceptance_datetime ?? metadata?.published_at ?? metadata?.as_of ?? metadata?.timestamp;
  if (stamp == null) return undefined;
  const t = typeof stamp === "number" ? stamp : Date.parse(String(stamp));
  return Number.isFinite(t) ? t : undefined;
}

function cleanMetadata(metadata: ContextDocument["metadata"], text: string, userId: string): RecordMetadata {
  // Derive scope from the userId sentinel used to signal the shared/public tier.
  // New vectors carry an explicit `scope` field; legacy vectors written before this change
  // do NOT have it (backward-compat: they are still matched via the userId filter).
  const scope: VectorScope = userId === "local" ? SHARED_SCOPE : PRIVATE_SCOPE;
  // Embedding-model/representation version tag (2026-07-04 RAG quick-wins): stamp every new vector
  // with the model that produced it + a representation revision, so a mixed population (e.g. after
  // a VOYAGE_MODEL swap or a VECTOR_EMBED_CLEAN_TEXT flip) can be detected/filtered/migrated later
  // instead of silently comparing across incompatible embedding spaces. Legacy vectors written
  // before this field existed simply lack it — treat missing as rev 0 (see EMBED_REV above).
  const out: Record<string, string | number | boolean | string[]> = {
    text,
    userId,
    scope,
    embed_model: VOYAGE_MODEL,
    embed_rev: EMBED_REV,
    // Direct/legacy-style writes have no relational receipt protocol and are committed by their
    // single successful upsert. `storeDocument` explicitly overrides these to pending/required,
    // then promotes them only after its exact receipt transaction.
    ingest_state: "committed",
    receipt_required: false
  };
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "text" || key === "userId" || key === "scope" || key === "embed_model" || key === "embed_rev") continue;
    // as_of_epoch_ms is DERIVED below from the date precedence, never copied from a caller-supplied
    // value — skip any inbound one so a stray/incorrect field can't override the authoritative
    // derivation (and so the "absent when undated" invariant can't be violated by a caller passing 0).
    if (key === AS_OF_EPOCH_FIELD) continue;
    if (key === "doc_type" && typeof value === "string") {
      // Normalize doc_type to lowercase AT WRITE TIME so every new vector is consistent, regardless
      // of what casing the caller passed in (some ingesters historically passed "10-K"/"10-Q").
      // Legacy mixed-case vectors already in Pinecone are unaffected — buildExtraFilters still
      // expands both casings at query time so old data stays matchable.
      out[key] = value.toLowerCase();
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(String).filter(Boolean);
  }
  // server-asof-filter (2026-07-06): additively stamp a NUMERIC point-in-time epoch (ms) derived
  // from the SAME acceptance_datetime -> published_at -> as_of -> timestamp precedence the post-fetch
  // guard uses, so a backtest's asOf can be pushed into the Pinecone query. Written ONLY when a date
  // actually resolves — an undated document leaves the field ABSENT, which is the fail-open signal
  // the query path relies on (absent vectors are not dropped server-side under the default). NaN-safe
  // via resolveAsOfEpochMs. Changes only NEW upserts; existing vectors are handled by the backfill.
  const asOfEpochMs = resolveAsOfEpochMs(metadata);
  if (asOfEpochMs != null) out[AS_OF_EPOCH_FIELD] = asOfEpochMs;
  return out as RecordMetadata;
}

function vectorUserIdFor(userId: string | undefined): string {
  return sanitizeUserId(userId);
}

export function vectorTenantScope(userId: string | undefined): string {
  const exact = String(userId ?? "local");
  if (exact === "local") return "shared:operator";
  return `private:${crypto.createHash("sha256").update(exact, "utf8").digest("hex")}`;
}

export function buildOccurrenceVectorId(input: {
  tenantScope: string;
  source: string;
  accession: string;
  contentVersion: string;
  section: string;
  ordinal: number;
  parserRevision: string;
  embedRevision: string;
}): string {
  const canonical = JSON.stringify([
    input.tenantScope,
    input.source,
    input.accession,
    input.contentVersion,
    input.section,
    input.ordinal,
    input.parserRevision,
    input.embedRevision
  ]);
  return `occ:v2:${crypto.createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function sanitizeVectorId(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (sanitized.length <= 512) return sanitized;
  // Preserve the tail where unique suffixes (ordinal, parserRev, embedRev) live.
  // Taking a blind prefix slice can drop the only differing portion when a
  // document title or section has a long common prefix, causing multiple
  // chunks to share the same truncated ID.
  const headLen = 384;
  const tailMarker = "..";
  const tailLen = 512 - headLen - tailMarker.length;
  return sanitized.slice(0, headLen) + tailMarker + sanitized.slice(-tailLen);
}

function contextId(document: ContextDocument, fallbackIndex: number): string {
  if (document.metadata?.vector_id) {
    return sanitizeVectorId(String(document.metadata.vector_id));
  }
  const { symbol, source, accession, timestamp } = document.metadata;
  const raw = [source, symbol, accession, timestamp].filter(Boolean).join(":") || `${symbol}:${source}:${fallbackIndex}`;
  return sanitizeVectorId(raw);
}

function estimatePineconeWriteUnitsForDocument(document: ContextDocument, vectorUserId: string): number {
  const metadata = cleanMetadata(document.metadata, document.text, vectorUserId);
  const idBytes = Buffer.byteLength(contextId(document, 0), "utf8");
  // Pinecone bills by request size. This pre-embed estimate uses float32 vector bytes plus
  // metadata/id overhead so the budget can stop before paying Voyage to embed doomed writes.
  return estimatePineconeRecordWriteUnits(idBytes + pineconeMetadataBytes(metadata) + EMBEDDING_DIMENSION * 4 + 512);
}

function estimatePineconeWriteUnitsForRecords(records: PineconeRecord<RecordMetadata>[]): number {
  if (records.length === 0) return 0;
  const bytes = records.reduce((sum, record) => {
    const values = Array.isArray(record.values) ? record.values : [];
    const dimension = Math.max(values.length, EMBEDDING_DIMENSION);
    return (
      sum +
      Buffer.byteLength(String(record.id), "utf8") +
      pineconeMetadataBytes(record.metadata ?? {}) +
      dimension * 4 +
      512
    );
  }, 0);
  return Math.max(5, Math.ceil(bytes / 1024));
}

function pineconeReadUnits(result: unknown, fallback: number): number {
  const usage = (result as { usage?: Record<string, unknown> } | undefined)?.usage;
  const raw = usage?.readUnits ?? usage?.read_units ?? usage?.readUnit ?? usage?.read_unit;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function applyPineconeWriteBudget(
  documents: ContextDocument[],
  userId: string,
  vectorUserId: string
): { documents: ContextDocument[]; skipped: number; used: number; limit: number; requested: number; allowed: number } {
  const limit = pineconeMaxWriteUnitsPerDay();
  if (!pineconeWriteBudgetEnabled()) {
    return { documents, skipped: 0, used: 0, limit, requested: 0, allowed: Number.POSITIVE_INFINITY };
  }

  const used = usedPineconeWriteUnitsLast24h(userId);
  let remaining = Math.max(0, limit - used);
  let requested = 0;
  let accepting = true;
  const allowedDocuments: ContextDocument[] = [];

  for (const document of documents) {
    const estimated = estimatePineconeWriteUnitsForDocument(document, vectorUserId);
    requested += estimated;
    if (accepting && remaining >= estimated) {
      remaining -= estimated;
      allowedDocuments.push(document);
    } else {
      accepting = false;
    }
  }

  return {
    documents: allowedDocuments,
    skipped: documents.length - allowedDocuments.length,
    used,
    limit,
    requested,
    allowed: Math.max(0, limit - used)
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function trimContextText(text: string, maxCharsOverride?: number): string {
  const trimmed = text.trim();
  const maxChars = maxCharsOverride ?? contextMaxChars();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n[truncated for vector memory]`;
}

function isRateLimitError(error: unknown): boolean {
  const maybeStatus = (error as { status?: unknown; statusCode?: unknown }) ?? {};
  if (maybeStatus.status === 429 || maybeStatus.statusCode === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate limit|too many requests|RPM|TPM/i.test(message);
}

export function retryAfterMs(error: unknown, attempt: number): number {
  const headers =
    (error as { headers?: { get?: (name: string) => string | null } })?.headers ??
    (error as { response?: { headers?: { get?: (name: string) => string | null } } })?.response?.headers;
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return dateDelay;
  }
  const batchDelay = embedBatchDelayMs();
  const baseDelay = embedRetryDelayMs();
  
  const backoff = Math.min(60_000, baseDelay * Math.pow(2, attempt));
  const delay = Math.random() * backoff;
  return Math.max(batchDelay, delay);
}

async function embedWithRetry(
  voyage: VoyageAIClient,
  input: string[],
  inputType: "document" | "query",
  signal: AbortSignal | undefined,
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<Awaited<ReturnType<VoyageAIClient["embed"]>>> {
  const attempts = embedRetryAttempts();
  for (let attempt = 0; ; attempt++) {
    try {
      const request = {
        model: VOYAGE_MODEL,
        input,
        inputType
      };
      return await withDurableRagProviderDispatch(
        "voyage",
        source,
        userId,
        `embed ${inputType}`,
        () => signal
          ? voyage.embed(request, { abortSignal: signal })
          : voyage.embed(request),
        leaseGuard,
        { estimatedCostUsd: estimateVoyageDispatchCost(input, "embed", VOYAGE_MODEL) }
      );
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : error;
      }
      if (!isRateLimitError(error) || attempt >= attempts) throw error;
      const delay = retryAfterMs(error, attempt);
      console.warn(`[vector-db] Voyage rate limited for inputType=${inputType}; retrying in ${Math.round(delay / 1000)}s.`);
      await sleep(delay, signal);
    }
  }
}

async function embedDocumentsWithRetry(
  voyage: VoyageAIClient,
  input: string[],
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<Awaited<ReturnType<VoyageAIClient["embed"]>>> {
  return embedWithRetry(voyage, input, "document", leaseGuard?.signal, source, userId, leaseGuard);
}

/**
 * Reorder Pinecone matches by Voyage cross-encoder relevance and keep the top `topK`. Pure
 * best-effort: on any error (rate limit, unsupported model, empty docs) returns the input order
 * unchanged so retrieval never breaks — reranking is a quality boost, not a dependency.
 *
 * Each returned match carries the reranker's own `relevanceScore` (Voyage's cross-encoder score,
 * distinct from the Pinecone cosine `score`) attached as `_rerankScore` — a non-enumerable-ish
 * plain field on a shallow copy of the match, so callers that only read `.score`/`.metadata` are
 * unaffected. `matchToChunk` reads `_rerankScore` into `RetrievedChunk.relevanceScore`.
 */
export async function rerankMatches(
  voyage: VoyageAIClient,
  query: string,
  matches: any[],
  topK: number,
  userId: string = "local",
  source: ApiKeySource = "env"
): Promise<any[]> {
  if (matches.length <= 1) return matches;
  const documents = matches.map((m) => {
    const t = (m?.metadata as Record<string, unknown> | undefined)?.text;
    return typeof t === "string" ? t : "";
  });
  if (documents.every((d) => !d)) return matches;
  try {
    const resp = await withRagApiHealth(
      "voyage-rerank",
      source,
      userId,
      "rerank",
      () => voyage.rerank({
        query,
        documents,
        model: rerankModel(),
        topK: Math.min(topK, matches.length),
        truncation: true
      }),
      undefined,
      { estimatedCostUsd: estimateVoyageDispatchCost([query, ...documents], "rerank", rerankModel()) }
    );
    meterRerank(query, documents, rerankModel(), userId);
    recordRagOperation(); // R16: count this rerank call against the per-run budget (no-op unless enabled).
    const data = resp.data ?? [];
    if (data.length === 0) return matches;
    const reordered: any[] = [];
    for (const item of data) {
      const idx = item.index;
      const relevanceScore = typeof item.relevanceScore === "number" ? item.relevanceScore : undefined;
      if (typeof idx === "number" && matches[idx]) {
        reordered.push(relevanceScore != null ? { ...matches[idx], _rerankScore: relevanceScore } : matches[idx]);
      }
    }
    return reordered.length > 0 ? reordered : matches;
  } catch (err) {
    console.warn("[vector-db] rerank failed; falling back to cosine order:", err instanceof Error ? err.message : String(err));
    return matches;
  }
}

/**
 * Store a document context into Pinecone.
 */
export async function storeContext(
  text: string,
  metadata: ContextDocument["metadata"],
  userId: string = "local"
): Promise<void> {
  await storeContexts(
    [{ text, metadata }],
    userId,
    envFlagOn("VECTOR_STORECONTEXTS_DEDUP", true) ? { dedupKeyPrefix: "direct-context" } : undefined
  );
}

export interface StoreContextsOptions {
  /**
   * Per-call override for the trim cap applied to each document's text (chars). Defaults to
   * `contextMaxChars()` (env-tunable `VECTOR_CONTEXT_MAX_CHARS`, 2400) when omitted — so existing
   * callers (8-K summaries, disclosure docs) are byte-for-byte unchanged. `storeDocument` passes a
   * cap derived from the actual chunker token budget so an already-atomic, already-token-bounded
   * chunk (e.g. a table kept whole by chunkDocument) isn't silently re-truncated here.
   */
  maxChars?: number;
  /**
   * R10 (2026-07-01 RAG backlog): opt-in content_hash dedup for THIS storeContexts call. When set,
   * documents whose trimmed-text SHA-256 (the same `hashContent` helper `chunk.ts`/`storeDocument`
   * already use for dedup) is already present in `document_chunks` are skipped entirely — no Voyage
   * embed, no Pinecone upsert. Newly-indexed documents are recorded into `document_chunks` under a
   * synthetic `source` of `${dedupKeyPrefix}:<doc.metadata.source>` so this call's dedup namespace
   * never collides with `storeDocument`'s own per-source hashes (the two dedup populations are
   * intentionally kept in the same table but distinguishable by source prefix, since `document_chunks`
   * is keyed on content_hash ALONE — a real collision on identical text across sources is the
   * desired outcome: identical text truly doesn't need re-embedding twice).
   *
   * Default omitted/undefined = current behavior (always re-embeds), so `sec8k.ts`'s existing
   * unconditional refresh cadence and any other unmigrated caller is completely unaffected.
   * Keys on TEXT content, not accession/id — a genuinely-updated filing (different text) still
   * re-embeds even if the accession/contextId is stable.
   */
  dedupKeyPrefix?: string;
  /**
   * Reuse only exact, model/revision-matched document embeddings from a bounded process-local cache.
   * Pinecone records are still upserted once per input document with their own id and metadata; a
   * cache hit skips Voyage only, never the occurrence vector or its query-time filters/citation.
   */
  reuseExactEmbeddings?: boolean;
  /**
   * Optional durable-operation guard for long-running producers. The callback is invoked at each
   * provider/write boundary and the signal is forwarded to Voyage, so a producer that loses its
   * outer lease stops before another paid or persistent side effect.
   */
  leaseGuard?: VectorStoreLeaseGuard;
  /** Internal two-phase commit used by storeDocument. Pending records are first upserted, then this
   * exact local receipt callback runs, then the same records are re-upserted as committed. */
  managedCommit?: {
    persistReceipts: () => void;
    markCommitted: () => void;
  };
}

export interface VectorStoreLeaseGuard {
  assertOwnership: () => void;
  signal?: AbortSignal;
}

function documentEmbeddingInput(document: ContextDocument): string {
  const source = document.embeddingText?.trim() || document.text;
  return embedCleanTextEnabled() ? stripPublishedPrefix(source) : source;
}

class VectorStoreLeaseLostError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : "Vector-store operation lease was lost.", {
      cause: cause instanceof Error ? cause : undefined
    });
    this.name = "VectorStoreLeaseLostError";
  }
}

function assertVectorStoreLease(guard: VectorStoreLeaseGuard | undefined): void {
  if (!guard) return;
  if (guard.signal?.aborted) {
    throw new VectorStoreLeaseLostError(guard.signal.reason);
  }
  try {
    guard.assertOwnership();
  } catch (error) {
    throw new VectorStoreLeaseLostError(error);
  }
}

async function settleRagSideEffect(
  effect: Promise<void>,
  leaseGuard: VectorStoreLeaseGuard | undefined
): Promise<void> {
  if (!leaseGuard) {
    // Preserve the established best-effort/non-blocking behavior for callers with no durable owner.
    void effect;
    return;
  }
  await effect;
  assertVectorStoreLease(leaseGuard);
}

/**
 * Store multiple context documents in one embedding/upsert flow. This keeps Pinecone index
 * creation centralized and avoids one Voyage/Pinecone round-trip per SEC filing.
 */
export async function storeContexts(
  documents: ContextDocument[],
  userId: string = "local",
  options?: StoreContextsOptions
): Promise<StoreContextsResult> {
  assertVectorStoreLease(options?.leaseGuard);
  const vectorUserId = vectorUserIdFor(userId);
  const validDocuments = documents
    .map((doc) => {
      let text = doc.text;
      const timestamp = doc.metadata?.timestamp;
      if (timestamp) {
        let tsStr = "";
        if (typeof timestamp === "number") {
          try {
            tsStr = new Date(timestamp).toISOString();
          } catch {
            tsStr = String(timestamp);
          }
        } else if ((timestamp as any) instanceof Date) {
          try {
            tsStr = (timestamp as any).toISOString();
          } catch {}
        } else {
          tsStr = String(timestamp).trim();
        }

        const dateMatch = tsStr.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const dateStr = dateMatch[1];
          const prefix = `[Published: ${dateStr}]`;
          if (!text.startsWith("[Published:")) {
            text = `${prefix} ${text}`;
          }
        }
      }
      // Atomic table chunks (chunk.ts never splits a table, regardless of token count) are EXEMPT
      // from char trimming — truncating mid-row would corrupt numeric data, which is worse than a
      // large vector. content_hash (computed pre-trim in chunk.ts) stays consistent with the stored
      // text specifically because this chunk never gets trimmed.
      const isTable = doc.metadata?.is_table === true;
      const storedText = isTable ? text.trim() : trimContextText(text, options?.maxChars);
      const rawEmbeddingText = doc.embeddingText?.trim();
      const embeddingText = rawEmbeddingText
        ? (isTable ? rawEmbeddingText : trimContextText(rawEmbeddingText, options?.maxChars))
        : undefined;
      return { ...doc, text: storedText, ...(embeddingText ? { embeddingText } : {}) };
    })
    .filter((doc) => doc.text.length > 0);
  if (validDocuments.length === 0) return { attempted: 0, indexed: 0 };

  // R10 (2026-07-01 RAG backlog): opt-in content_hash dedup for this call, gated on
  // `dedupKeyPrefix` being set. Reuses the same SHA-256-first-16 `hashContent` helper
  // `storeDocument`/`chunk.ts` use, and the same `document_chunks` table/CRUD — keyed on the
  // FINAL (post-trim) text of each document so a repeat call with byte-identical text (e.g. an
  // unchanged 8-K summary re-embedded on every refresh cycle) is skipped before any Voyage/Pinecone
  // call. Default (dedupKeyPrefix unset) = current behavior, always re-embeds.
  const dedupPrefix = options?.dedupKeyPrefix;
  let dedupHashes: Array<{ content_hash: string; symbol: string; source: string; chunk_id: string }> | undefined;
  let documentsToStore = validDocuments;
  let skippedByDedup = 0;
  if (dedupPrefix) {
    dedupHashes = validDocuments.map((doc) => ({
      content_hash: hashContent(doc.text),
      symbol: doc.metadata?.symbol ?? "",
      source: `${dedupPrefix}:${doc.metadata?.source ?? ""}`,
      chunk_id: contextId(doc, 0)
    }));
    const newHashes = filterNewDocumentChunks(dedupHashes);
    const newHashSet = new Set(newHashes.map((h) => h.content_hash));
    documentsToStore = validDocuments.filter((_doc, i) => newHashSet.has(dedupHashes![i]!.content_hash));
    skippedByDedup = validDocuments.length - documentsToStore.length;
    if (skippedByDedup > 0) {
      console.log(`[vector-db] Content-hash dedup (storeContexts, prefix="${dedupPrefix}"): ${skippedByDedup}/${validDocuments.length} document(s) already indexed, skipping.`);
    }
    // Re-key dedupHashes/documentsToStore in lockstep so the later insertDocumentChunks call
    // below can zip surviving documents back to their hashes without recomputing anything.
    dedupHashes = documentsToStore.map((doc) => ({
      content_hash: hashContent(doc.text),
      symbol: doc.metadata?.symbol ?? "",
      source: `${dedupPrefix}:${doc.metadata?.source ?? ""}`,
      chunk_id: contextId(doc, 0)
    }));
  }
  if (documentsToStore.length === 0) {
    return { attempted: validDocuments.length, indexed: 0, skipped: true, dedupComplete: true };
  }

  const reuseExactEmbeddings = options?.reuseExactEmbeddings === true;
  const cachedDocumentEmbeddings = new Map<ContextDocument, number[]>();
  const uniqueMissingEmbeddingInputs: string[] = [];
  const missingEmbeddingInputSet = new Set<string>();
  if (reuseExactEmbeddings) {
    for (const document of documentsToStore) {
      const input = documentEmbeddingInput(document);
      const cached = getCachedDocumentEmbedding(input);
      if (cached) {
        cachedDocumentEmbeddings.set(document, cached);
      } else if (!missingEmbeddingInputSet.has(input)) {
        missingEmbeddingInputSet.add(input);
        uniqueMissingEmbeddingInputs.push(input);
      }
    }
  }

  let budgetSkipped = 0;
  assertVectorStoreLease(options?.leaseGuard);
  const requestedEmbeddingTexts = reuseExactEmbeddings
    ? uniqueMissingEmbeddingInputs.length
    : documentsToStore.length;
  const budget = remainingIngestTexts(userId, requestedEmbeddingTexts);
  if (budget.allowed < requestedEmbeddingTexts) {
    const providerTextsSkipped = requestedEmbeddingTexts - budget.allowed;
    const beforeBudgetDocuments = documentsToStore;
    const beforeBudgetHashes = dedupHashes;
    if (reuseExactEmbeddings) {
      const allowedMissingInputs = new Set(uniqueMissingEmbeddingInputs.slice(0, budget.allowed));
      const keptIndexes: number[] = [];
      for (let index = 0; index < beforeBudgetDocuments.length; index++) {
        const document = beforeBudgetDocuments[index]!;
        if (cachedDocumentEmbeddings.has(document) || allowedMissingInputs.has(documentEmbeddingInput(document))) {
          keptIndexes.push(index);
        }
      }
      documentsToStore = keptIndexes.map((index) => beforeBudgetDocuments[index]!);
      if (beforeBudgetHashes) dedupHashes = keptIndexes.map((index) => beforeBudgetHashes[index]!);
      budgetSkipped = beforeBudgetDocuments.length - documentsToStore.length;
    } else {
      budgetSkipped = beforeBudgetDocuments.length - budget.allowed;
      documentsToStore = beforeBudgetDocuments.slice(0, budget.allowed);
      if (beforeBudgetHashes) dedupHashes = beforeBudgetHashes.slice(0, budget.allowed);
    }
    const budgetPayload = {
      requested: requestedEmbeddingTexts,
      allowed: budget.allowed,
      skipped: providerTextsSkipped,
      skippedOccurrences: budgetSkipped,
      usedLast24h: budget.used,
      limitPer24h: budget.limit
    };
    audit("vector_ingest_budget", budgetPayload, userId);
    await settleRagSideEffect(alertUsageLimitHit({
      userId,
      provider: "Voyage",
      operation: "embed-budget",
      limitName: "RAG ingest text daily cap",
      status: budget.allowed === 0 ? "exceeded" : "warning",
      used: budget.used,
      limit: budget.limit,
      attempted: requestedEmbeddingTexts,
      skipped: providerTextsSkipped,
      unit: "texts",
      recommendation:
        "If this happened during a deliberate backfill, raise RAG_INGEST_MAX_TEXTS_PER_DAY temporarily. If it happened during normal use, inspect deduping and ingestion cadence first."
    }, {
      assertActive: options?.leaseGuard ? () => assertVectorStoreLease(options.leaseGuard) : undefined,
      signal: options?.leaseGuard?.signal
    }), options?.leaseGuard);
    await settleRagSideEffect(captureRagSentryMessage("warning", "RAG ingest text budget reached", {
      provider: "voyage",
      operation: "embed-budget",
      source: userId === "local" ? "operator" : "user",
      requested: requestedEmbeddingTexts,
      allowed: budget.allowed,
      skipped: providerTextsSkipped,
      skippedOccurrences: budgetSkipped,
      usedLast24h: budget.used,
      limitPer24h: budget.limit
    }, options?.leaseGuard), options?.leaseGuard);
    if (documentsToStore.length === 0) {
      const lastIngest = {
        at: new Date().toISOString(),
        attempted: validDocuments.length,
        indexed: 0,
        budgetSkipped,
        budget: budgetPayload
      };
      setInternalSetting(LAST_INGEST_KEY, lastIngest);
      audit("vector_store", { ok: true, attempted: validDocuments.length, indexed: 0, budgetSkipped }, userId);
      return { attempted: validDocuments.length, indexed: 0, skipped: true, budgetSkipped };
    }
  }

  let writeUnitBudgetSkipped = 0;
  assertVectorStoreLease(options?.leaseGuard);
  const writeBudget = applyPineconeWriteBudget(documentsToStore, userId, vectorUserId);
  if (writeBudget.skipped > 0) {
    writeUnitBudgetSkipped = writeBudget.skipped;
    const budgetPayload = {
      requestedEstimatedWriteUnits: writeBudget.requested,
      allowedEstimatedWriteUnits: writeBudget.allowed,
      skipped: writeUnitBudgetSkipped,
      usedLast24h: writeBudget.used,
      limitPer24h: writeBudget.limit
    };
    audit("vector_write_unit_budget", budgetPayload, userId);
    await settleRagSideEffect(alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: writeBudget.documents.length === 0 ? "exceeded" : "warning",
      used: writeBudget.used,
      limit: writeBudget.limit,
      attempted: writeBudget.requested,
      skipped: writeUnitBudgetSkipped,
      unit: "estimated WUs",
      recommendation:
        "50k/day should be enough for normal incremental single-trader use. If this fires outside a planned backfill, inspect chunking, deduping, and repeated agent writes before raising the cap."
    }, {
      assertActive: options?.leaseGuard ? () => assertVectorStoreLease(options.leaseGuard) : undefined,
      signal: options?.leaseGuard?.signal
    }), options?.leaseGuard);
    await settleRagSideEffect(captureRagSentryMessage("warning", "Pinecone write unit budget reached", {
      provider: "pinecone",
      operation: "upsert-budget",
      source: userId === "local" ? "operator" : "user",
      requestedEstimatedWriteUnits: writeBudget.requested,
      allowedEstimatedWriteUnits: writeBudget.allowed,
      skipped: writeUnitBudgetSkipped,
      usedLast24h: writeBudget.used,
      limitPer24h: writeBudget.limit
    }, options?.leaseGuard), options?.leaseGuard);
    if (writeBudget.documents.length === 0) {
      const lastIngest = {
        at: new Date().toISOString(),
        attempted: validDocuments.length,
        indexed: 0,
        writeUnitBudgetSkipped,
        writeBudget: budgetPayload
      };
      setInternalSetting(LAST_INGEST_KEY, lastIngest);
      audit("vector_store", { ok: true, attempted: validDocuments.length, indexed: 0, writeUnitBudgetSkipped }, userId);
      return { attempted: validDocuments.length, indexed: 0, skipped: true, budgetSkipped, writeUnitBudgetSkipped };
    }
    documentsToStore = writeBudget.documents;
    if (dedupHashes) dedupHashes = dedupHashes.slice(0, documentsToStore.length);
  }

  const { pc, voyage, initCacheKey, pineconeSource, voyageSource } = await getClients(userId, options?.leaseGuard);
  if (!pc || !voyage) {
    console.log("[vector-db] Skipping storeContexts: Missing Voyage or Pinecone keys.");
    await settleRagSideEffect(captureRagSentryMessage("warning", "RAG store skipped: missing Pinecone or Voyage key", {
      provider: !pc ? "pinecone" : "voyage",
      operation: "storeContexts",
      source: userId === "local" ? "operator" : "user",
      attempted: validDocuments.length
    }, options?.leaseGuard), options?.leaseGuard);
    audit("vector_store", { ok: false, attempted: validDocuments.length, indexed: 0, skipped: true, reason: "missing Pinecone/Voyage keys" }, userId);
    return { attempted: validDocuments.length, indexed: 0, skipped: true, unconfigured: true };
  }

  let indexed = 0;
  let rejectedInvalidEmbeddings = 0;
  const managedRecordBatches: Array<PineconeRecord<RecordMetadata>[]> = [];
  // R10: content_hash of each document actually upserted (not rejected by the R2 integrity
  // guard), keyed by identity against `documentsToStore` — only recorded into document_chunks
  // (via insertDocumentChunks below) when dedup is active for this call.
  const indexedDocIdentities = new Set<ContextDocument>();
  try {
    assertVectorStoreLease(options?.leaseGuard);
    await ensureIndex(pc, initCacheKey, pineconeSource, userId, options?.leaseGuard);
    assertVectorStoreLease(options?.leaseGuard);
    const index = pc.Index(indexName());
    const batches = chunks(documentsToStore, embedBatchSize());

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      if (!batch) continue;
      if (batchIndex > 0) await sleep(embedBatchDelayMs(), options?.leaseGuard?.signal);
      assertVectorStoreLease(options?.leaseGuard);
      // The stored citation text and the text embedded by Voyage can intentionally differ:
      // storeDocument retains occurrence-specific headers for display while embedding exact raw
      // chunk content. Exact cache hits skip Voyage only; every document below still gets its own
      // Pinecone id/metadata record and therefore remains independently queryable by symbol/PIT.
      const embedInputs = batch.map(documentEmbeddingInput);
      let batchEmbeddings: number[][] | undefined;
      let rejected = 0;
      let rejectionReason: ValidatedDocumentEmbeddingBatch["reason"];

      if (reuseExactEmbeddings) {
        const resolved = new Array<number[]>(batch.length);
        const missingInputs: string[] = [];
        const missingPositions = new Map<string, number[]>();
        for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch++) {
          const document = batch[indexInBatch]!;
          const input = embedInputs[indexInBatch]!;
          const cached = cachedDocumentEmbeddings.get(document) ?? getCachedDocumentEmbedding(input);
          if (cached) {
            resolved[indexInBatch] = cached;
            continue;
          }
          const positions = missingPositions.get(input);
          if (positions) positions.push(indexInBatch);
          else {
            missingInputs.push(input);
            missingPositions.set(input, [indexInBatch]);
          }
        }

        if (missingInputs.length > 0) {
          const response = await withRagApiHealth(
            "voyage",
            voyageSource,
            userId,
            "embed documents",
            () => embedDocumentsWithRetry(voyage, missingInputs, voyageSource, userId, options?.leaseGuard),
            options?.leaseGuard,
            { durablyTrackedInside: true }
          );
          assertVectorStoreLease(options?.leaseGuard);
          meterEmbed(missingInputs, undefined, userId);
          const validated = validateDocumentEmbeddingBatch(response.data, missingInputs.length);
          if (!validated.embeddings) {
            rejected = validated.rejected;
            rejectionReason = validated.reason;
          } else {
            for (let inputIndex = 0; inputIndex < missingInputs.length; inputIndex++) {
              const input = missingInputs[inputIndex]!;
              const embedding = validated.embeddings[inputIndex]!;
              setCachedDocumentEmbedding(input, embedding);
              for (const position of missingPositions.get(input) ?? []) resolved[position] = [...embedding];
            }
          }
        }
        const complete = Array.from({ length: batch.length }, (_unused, index) => isValidEmbedding(resolved[index])).every(Boolean);
        if (rejected === 0 && complete) batchEmbeddings = resolved;
        else if (rejected === 0) {
          rejected = Math.max(1, batch.length);
          rejectionReason = "invalid-embedding";
        }
      } else {
        const response = await withRagApiHealth(
          "voyage",
          voyageSource,
          userId,
          "embed documents",
          () => embedDocumentsWithRetry(voyage, embedInputs, voyageSource, userId, options?.leaseGuard),
          options?.leaseGuard,
          { durablyTrackedInside: true }
        );
        assertVectorStoreLease(options?.leaseGuard);
        meterEmbed(embedInputs, undefined, userId);
        const validated = validateDocumentEmbeddingBatch(response.data, batch.length);
        batchEmbeddings = validated.embeddings;
        rejected = validated.rejected;
        rejectionReason = validated.reason;
      }

      if (!batchEmbeddings) {
        rejectedInvalidEmbeddings += rejected;
        assertVectorStoreLease(options?.leaseGuard);
        console.warn(
          `[vector-db] Rejected Voyage document embedding batch (${rejectionReason ?? "invalid-response"}; expected=${batch.length}) — no records from this batch were upserted.`
        );
        // Stop spending after an integrity failure. Earlier batches may already be in Pinecone, but
        // deterministic ids make the whole document safe to retry and no content/occurrence receipt
        // is written while rejectedInvalidEmbeddings is non-zero.
        break;
      }

      const records: PineconeRecord<RecordMetadata>[] = batchEmbeddings.map((embedding, indexInBatch) => {
        const document = batch[indexInBatch]!;
        indexedDocIdentities.add(document);
        return {
          id: contextId(document, indexInBatch),
          values: embedding,
          metadata: cleanMetadata(document.metadata, document.text, vectorUserId)
        };
      });

      if (records.length > 0) {
        const estimatedWriteUnits = estimatePineconeWriteUnitsForRecords(records);
        assertVectorStoreLease(options?.leaseGuard);
        // Pinecone JS SDK v8 takes an options object ({ records }), not a bare array.
        await withRagApiHealth(
          "pinecone",
          pineconeSource,
          userId,
          "upsert",
          () => index.upsert({ records } as any),
          options?.leaseGuard
        );
        assertVectorStoreLease(options?.leaseGuard);
        indexed += records.length;
        if (options?.managedCommit) managedRecordBatches.push(records);
        meterPineconeUpsert(records.length, userId, estimatedWriteUnits);
      }
    }

    if (
      options?.managedCommit &&
      rejectedInvalidEmbeddings === 0 &&
      indexed === documentsToStore.length
    ) {
      assertVectorStoreLease(options.leaseGuard);
      try {
        // This is the exact relational receipt transaction. Provider records are still pending and
        // server-side retrieval filters exclude them if this callback throws.
        options.managedCommit.persistReceipts();
      } catch (error) {
        throw new Error("document-receipt-write-failed", { cause: error });
      }
      assertVectorStoreLease(options.leaseGuard);
      for (const pendingRecords of managedRecordBatches) {
        const committedRecords = pendingRecords.map((record) => ({
          ...record,
          metadata: { ...record.metadata, ingest_state: "committed" }
        }));
        const estimatedWriteUnits = estimatePineconeWriteUnitsForRecords(committedRecords);
        await withRagApiHealth(
          "pinecone",
          pineconeSource,
          userId,
          "commit managed vectors",
          () => index.upsert({ records: committedRecords } as any),
          options.leaseGuard,
          { units: 1 }
        );
        assertVectorStoreLease(options.leaseGuard);
        meterPineconeUpsert(committedRecords.length, userId, estimatedWriteUnits);
      }
      try {
        options.managedCommit.markCommitted();
      } catch (error) {
        throw new Error("document-local-commit-finalize-failed", { cause: error });
      }
      assertVectorStoreLease(options.leaseGuard);
    }

    if (rejectedInvalidEmbeddings > 0) {
      assertVectorStoreLease(options?.leaseGuard);
      audit("vector_embedding_integrity", { rejected: rejectedInvalidEmbeddings, attempted: validDocuments.length }, userId);
      await captureRagSentryMessage("warning", "Voyage document embedding integrity rejection", {
        provider: "voyage",
        operation: "embed documents",
        source: voyageSource,
        attempted: validDocuments.length,
        rejected: rejectedInvalidEmbeddings
      }, options?.leaseGuard);
    }
    assertVectorStoreLease(options?.leaseGuard);
    console.log(`[vector-db] Indexed ${indexed}/${validDocuments.length} context document(s).${rejectedInvalidEmbeddings > 0 ? ` (${rejectedInvalidEmbeddings} rejected: malformed embedding)` : ""}`);

    // R10: record newly-indexed content hashes so a repeat storeContexts call with the same
    // dedupKeyPrefix and byte-identical text skips re-embedding next time. Best-effort — a
    // failure here must not fail the store (the record was already upserted to Pinecone).
    if (dedupPrefix && dedupHashes && indexedDocIdentities.size > 0 && rejectedInvalidEmbeddings === 0) {
      assertVectorStoreLease(options?.leaseGuard);
      const toRecord = documentsToStore
        .map((doc, i) => (indexedDocIdentities.has(doc) ? dedupHashes![i] : undefined))
        .filter((h): h is { content_hash: string; symbol: string; source: string; chunk_id: string } => h != null);
      try {
        insertDocumentChunks(toRecord);
      } catch (err) {
        console.warn("[vector-db] insertDocumentChunks failed (non-fatal, storeContexts dedup path):", err instanceof Error ? err.message : String(err));
      }
    }

    // Persist the outcome so RAG ingestion health is visible in the audit log / dashboard
    // instead of being swallowed to console (the original cause of the silent empty index).
    const lastIngest = {
      at: new Date().toISOString(),
      attempted: validDocuments.length,
      indexed,
      ...(budgetSkipped > 0 ? { budgetSkipped } : {}),
      ...(writeUnitBudgetSkipped > 0 ? { writeUnitBudgetSkipped } : {})
    };
    assertVectorStoreLease(options?.leaseGuard);
    setInternalSetting(LAST_INGEST_KEY, lastIngest);
    audit("vector_store", { ok: true, attempted: validDocuments.length, indexed, rejectedInvalidEmbeddings, ...(budgetSkipped > 0 ? { budgetSkipped } : {}), ...(writeUnitBudgetSkipped > 0 ? { writeUnitBudgetSkipped } : {}) }, userId);
    return { attempted: validDocuments.length, indexed, ...(rejectedInvalidEmbeddings > 0 ? { rejectedInvalidEmbeddings } : {}), ...(budgetSkipped > 0 ? { budgetSkipped } : {}), ...(writeUnitBudgetSkipped > 0 ? { writeUnitBudgetSkipped } : {}) };
  } catch (err) {
    // Lease loss is a concurrency boundary, not a provider failure. Propagate it without writing
    // success/failure ledgers after ownership has moved to a successor. Voyage receives the abort
    // signal directly; Pinecone's high-level upsert API is only cooperatively guarded before/after,
    // and deterministic vector ids make a completed in-flight upsert safe to retry idempotently.
    if (err instanceof VectorStoreLeaseLostError) throw err;
    // SDK AbortErrors and abort-aware retry sleeps surface their raw reason. Re-check the guard
    // before any failure ledger, audit, or alert so lease loss cannot write after ownership moved.
    assertVectorStoreLease(options?.leaseGuard);
    const error = err instanceof Error ? err.message : String(err);
    console.error("[vector-db] Error storing contexts:", err);
    setInternalSetting(LAST_INGEST_KEY, { at: new Date().toISOString(), attempted: validDocuments.length, indexed, error });
    audit("vector_store", { ok: false, attempted: validDocuments.length, indexed, error }, userId);
    if (!wasRagSentryCaptured(err)) {
      await captureRagSentryMessage("error", "RAG vector store failed", {
        provider: "pinecone",
        operation: "storeContexts",
        source: userId === "local" ? "operator" : "user",
        attempted: validDocuments.length,
        indexed,
        reason: error
      }, options?.leaseGuard);
    }
    return { attempted: validDocuments.length, indexed, error };
  }
}

/**
 * Chunk a long document (structure-aware) and store each chunk as its own vector, carrying
 * `acceptance_datetime` so retrieval can apply a point-in-time (`as_of`) filter. Prefer this over
 * storeContexts for anything longer than a short catalyst summary (e.g. full 10-K risk sections).
 */
export interface StoreDocumentOptions extends ChunkOptions {
  /** Guard inherited from the producer's durable shared vector-ingest lease. */
  leaseGuard?: VectorStoreLeaseGuard;
  /** Full source-content version (normally SHA-256). Defaults to SHA-256 of the input body. */
  contentVersion?: string;
  /** Parser/chunker identity included in every collision-safe occurrence id. */
  parserRevision?: string;
}

type DocumentChunkReceipt = Parameters<typeof insertDocumentChunks>[0][number];
type ChunkOccurrenceReceipt = Parameters<typeof dbModule.insertManagedChunkOccurrences>[0][number];

function persistDocumentReceipts(
  chunksToRecord: DocumentChunkReceipt[],
  occurrencesToRecord: ChunkOccurrenceReceipt[],
  commitId: string
): void {
  // Both receipts describe one completed external write set. Nested better-sqlite3 transactions use
  // savepoints, so either every local receipt commits or neither does; an idempotent retry can then
  // safely overwrite the deterministic Pinecone ids and retry this transaction.
  const db = dbModule.getDb();
  db.transaction(() => {
    insertDocumentChunks(chunksToRecord);
    dbModule.insertManagedChunkOccurrences(occurrencesToRecord);
    if (typeof dbModule.markVectorCommitReceiptsPersisted === "function") {
      dbModule.markVectorCommitReceiptsPersisted(commitId);
    } else if (process.env.NODE_ENV !== "test") {
      throw new Error("Vector commit receipt ledger is unavailable.");
    }

    // The CRUD helpers intentionally use INSERT OR IGNORE for idempotency. Verify the postcondition
    // inside the same transaction so a conflicting/stale occurrence cannot be mistaken for a
    // successful receipt merely because SQLite did not throw.
    const findChunk = db.prepare("SELECT 1 AS ok FROM document_chunks WHERE content_hash = ?");
    for (const chunk of chunksToRecord) {
      if (!findChunk.get(chunk.content_hash)) throw new Error("document_chunks receipt was not persisted");
    }
    const findOccurrence = db.prepare(`
      SELECT 1 AS ok
      FROM chunk_occurrences
      WHERE vector_id = ? AND content_hash = ? AND symbol = ? AND source = ? AND accession = ?
        AND sequence IS ? AND document_name IS ? AND section = ? AND ordinal = ? AND accepted_at = ?
        AND tenant_scope = ? AND content_version = ? AND commit_id = ? AND receipt_state = 'pending'
    `);
    for (const occurrence of occurrencesToRecord) {
      if (!findOccurrence.get(
        occurrence.vectorId,
        occurrence.contentHash,
        occurrence.symbol,
        occurrence.source,
        occurrence.accession,
        occurrence.sequence ?? null,
        occurrence.documentName ?? null,
        occurrence.section,
        occurrence.ordinal,
        occurrence.acceptedAt,
        occurrence.tenantScope,
        occurrence.contentVersion,
        occurrence.commitId
      )) throw new Error("chunk_occurrences receipt was not persisted");
    }
  })();
}

export async function storeDocument(
  doc: ChunkInput & { symbol?: string },
  userId: string = "local",
  options?: StoreDocumentOptions
): Promise<StoreContextsResult> {
  assertVectorStoreLease(options?.leaseGuard);
  const chunked = chunkDocument(doc, options);
  const fallbackSymbol = doc.symbol ?? (Array.isArray(doc.ticker) ? doc.ticker[0] : doc.ticker) ?? "";
  const source = doc.source || "sec-edgar";

  // A content hash identifies content, never an occurrence. Every occurrence still receives a real
  // Pinecone record with its own symbol/accession/PIT metadata; exact embeddings may be reused, but
  // vectors and citations are never deduplicated away.
  const chunkHashes = chunked.map((c) => ({
    content_hash: c.content_hash,
    symbol: c.ticker[0] ?? fallbackSymbol,
    source,
    chunk_id: c.chunk_id
  }));

  const embedRev = `v${EMBED_REV}`;
  const parserRev = options?.parserRevision?.trim() || "v1";
  const accession = doc.doc_id || "unknown_accession";
  const contentVersion = options?.contentVersion?.trim() ||
    crypto.createHash("sha256").update(doc.text, "utf8").digest("hex");
  const tenantScope = vectorTenantScope(userId);
  const sequence = 1;
  const documentName = doc.title || "main.html";
  const now = new Date().toISOString();
  const occurrenceDescriptors = chunked.map((chunk, index) => {
    const ordinal = index + 1;
    const cleanSection = chunk.section || "body";
    const vectorId = buildOccurrenceVectorId({
      tenantScope,
      source,
      accession,
      contentVersion,
      section: cleanSection,
      ordinal,
      parserRevision: parserRev,
      embedRevision: embedRev
    });
    return { chunk, ordinal, vectorId };
  });
  const commitId = `vcommit:v1:${crypto.createHash("sha256").update(JSON.stringify([
    tenantScope,
    source,
    accession,
    contentVersion,
    parserRev,
    embedRev,
    occurrenceDescriptors.map((item) => item.vectorId)
  ]), "utf8").digest("hex")}`;
  if (typeof dbModule.beginVectorCommit === "function") {
    dbModule.beginVectorCommit({
      id: commitId,
      tenantScope,
      userId,
      source,
      accession,
      contentVersion,
      parserRevision: parserRev,
      embedRevision: embedRev,
      expectedVectors: occurrenceDescriptors.length,
      now
    });
  } else if (process.env.NODE_ENV !== "test") {
    throw new Error("Vector commit ledger is unavailable.");
  }

  const documents: ContextDocument[] = occurrenceDescriptors.map(({ chunk, ordinal, vectorId }) => ({
    text: `${chunk.context_header}\n\n${chunk.text}`,
    // The vector is content-derived and safe to reuse; the stored text/metadata below remains
    // occurrence-specific for filtering, point-in-time correctness, and citation display.
    embeddingText: chunk.text,
    metadata: {
      symbol: chunk.ticker[0] ?? fallbackSymbol,
      source: chunk.source,
      timestamp: chunk.published_at,
      accession,
      chunk_id: chunk.chunk_id,
      acceptance_datetime: chunk.acceptance_datetime,
      section: chunk.section,
      doc_type: chunk.doc_type,
      is_table: chunk.is_table,
      ticker: chunk.ticker,
      content_hash: chunk.content_hash,
      vector_id: vectorId,
      tenant_scope: tenantScope,
      content_version: contentVersion,
      vector_commit_id: commitId,
      chunk_ordinal: ordinal,
      parser_revision: parserRev,
      embed_revision: embedRev,
      receipt_required: true,
      ingest_state: "pending",
      ...(doc.url ? { url: doc.url } : {})
    }
  }));
  const occurrencesToRecord: ChunkOccurrenceReceipt[] = occurrenceDescriptors.map(({ chunk, ordinal, vectorId }) => ({
    vectorId,
    contentHash: chunk.content_hash,
    symbol: chunk.ticker[0] || fallbackSymbol,
    source,
    accession,
    sequence,
    documentName,
    section: chunk.section || "body",
    ordinal,
    acceptedAt: chunk.acceptance_datetime || now,
    tenantScope,
    contentVersion,
    commitId,
    receiptState: "pending",
    createdAt: now
  }));

  // Align the storeContexts trim cap with the ACTUAL token budget chunkDocument used (plus the
  // citation header allowance). Table chunks remain untrimmed in storeContexts.
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const headerAllowance = 512;
  const chunkAlignedMaxChars = Math.max(contextMaxChars(), maxTokens * CHARS_PER_TOKEN_CEILING + headerAllowance);
  const result = await storeContexts(documents, userId, {
    maxChars: chunkAlignedMaxChars,
    reuseExactEmbeddings: true,
    leaseGuard: options?.leaseGuard,
    managedCommit: {
      persistReceipts: () => persistDocumentReceipts(chunkHashes, occurrencesToRecord, commitId),
      markCommitted: () => {
        if (typeof dbModule.markVectorCommitCommitted === "function") {
          dbModule.markVectorCommitCommitted(commitId);
        } else if (process.env.NODE_ENV !== "test") {
          throw new Error("Vector commit finalizer is unavailable.");
        }
      }
    }
  });
  assertVectorStoreLease(options?.leaseGuard);

  const vectorsComplete =
    chunked.length > 0 &&
    result.indexed === chunked.length &&
    !result.error &&
    (result.rejectedInvalidEmbeddings ?? 0) === 0 &&
    (result.budgetSkipped ?? 0) === 0 &&
    (result.writeUnitBudgetSkipped ?? 0) === 0;
  if (!vectorsComplete) {
    return { ...result, attempted: chunked.length, documentComplete: false };
  }

  assertVectorStoreLease(options?.leaseGuard);
  return { ...result, attempted: chunked.length, documentComplete: true };
}

/**
 * Resolve a chunk's point-in-time stamp using the same precedence `isWithinAsOf` applies:
 * acceptance_datetime -> published_at -> as_of -> timestamp. Returns `undefined` when none of
 * those keys are present/parseable — i.e. when the chunk has NO resolvable date stamp at all.
 * Exported so callers (the strict-mode drop-count in `rankPool`) can distinguish "undated chunk"
 * from "dated chunk that happens to be in-window" without duplicating the resolution chain.
 */
export function resolveAsOfStamp(metadata: Record<string, unknown> | undefined): number | undefined {
  const stamp = metadata?.acceptance_datetime ?? metadata?.published_at ?? metadata?.as_of ?? metadata?.timestamp;
  if (stamp == null) return undefined;
  const t = typeof stamp === "number" ? stamp : Date.parse(String(stamp));
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Point-in-time guard for retrieval: returns false when a chunk's
 * acceptance_datetime / as_of / timestamp is strictly after `asOf` — a lookahead-bias guard for
 * backtest-style queries.
 *
 * Default (`strict=false`, byte-identical to pre-R1 behavior): undated chunks and an unset/
 * unparseable `asOf` are KEPT (lenient/fail-open).
 *
 * `strict=true` (R1, 2026-07-01 expert-review follow-up, gated by `VECTOR_ASOF_STRICT` AND only
 * applied by callers when `options.asOf` is set): a chunk with NO resolvable stamp is DROPPED
 * instead of kept — closing the silent look-ahead hole an undated chunk otherwise represents for
 * a dated retrieval. An unset/unparseable `asOf` still short-circuits to "keep" even in strict
 * mode, since there is no point-in-time constraint to violate.
 */
export function isWithinAsOf(
  metadata: Record<string, unknown> | undefined,
  asOf: string | undefined,
  strict: boolean = false
): boolean {
  if (!asOf) return true;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return true;
  // Resolution precedence (R1, 2026-07-01 expert review): acceptance_datetime is the most precise
  // point-in-time anchor (when a filing was actually accepted by EDGAR); published_at is the next
  // best fallback (chunk.ts always populates it, even when acceptance_datetime is absent) — added
  // here so a chunk lacking acceptance_datetime doesn't fall all the way through to "include" when a
  // dated published_at is available. as_of/timestamp remain the final legacy fallbacks. This is
  // additive-only: any chunk that already had acceptance_datetime is unaffected.
  const t = resolveAsOfStamp(metadata);
  if (t == null) return !strict; // lenient: keep; strict: drop (no resolvable stamp under an active asOf)
  return t <= asOfMs;
}

/** Returns true when RAG_CITATION_STALENESS is truthy. Default OFF. */
export function citationStalenessEnabled(): boolean {
  return envFlagOn("RAG_CITATION_STALENESS", false);
}

/**
 * R13 (2026-07-01 RAG backlog) — heuristic, ADVISORY-ONLY staleness horizons per doc_type. These
 * are deliberately generous, documented, tunable defaults — NOT a validity judgment. A 10-K stays
 * "fresh" far longer than an 8-K because it's an annual filing; a transcript sits in between.
 * Override any horizon via env (days): RAG_STALENESS_DAYS_<DOC_TYPE_UPPERCASE_UNDERSCORED>.
 */
const DEFAULT_STALENESS_HORIZON_DAYS: Record<string, number> = {
  "10-k": 400,
  "10-q": 120,
  "8-k": 90,
  transcript: 120,
  "earnings-transcript": 120,
  "congress-trade": 60,
  "insider-filing": 90
};
const FALLBACK_STALENESS_HORIZON_DAYS = 180;

function stalenessHorizonDays(docType: string | undefined): number {
  const key = (docType ?? "").toLowerCase();
  const envKey = `RAG_STALENESS_DAYS_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const override = Number(process.env[envKey]);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_STALENESS_HORIZON_DAYS[key] ?? FALLBACK_STALENESS_HORIZON_DAYS;
}

/**
 * Heuristic recency label: true when `asOfIso` is older than the doc_type's staleness horizon.
 * Returns `undefined` (not `false`) when there's no resolvable `asOfIso` to judge — an unknown
 * age is NOT the same claim as "known to be fresh". ADVISORY ONLY: never gates retrieval, never
 * feeds any numeric/sizing path — purely a recency label a future citation UI may choose to
 * render. Callers must gate on `citationStalenessEnabled()` before calling this (kept as a
 * separate pure function so it's independently unit-testable).
 */
export function isStale(asOfIso: string | undefined, docType: string | undefined): boolean | undefined {
  if (!asOfIso) return undefined;
  const t = Date.parse(asOfIso);
  if (!Number.isFinite(t)) return undefined;
  const ageDays = (Date.now() - t) / (24 * 60 * 60 * 1000);
  return ageDays > stalenessHorizonDays(docType);
}

/**
 * Live Pinecone index stats — used by the reindex/diagnostic route so the operator can
 * confirm `totalVectorCount > 0` after a backfill instead of guessing.
 */
export async function getVectorStoreStats(userId: string = "local"): Promise<VectorStoreStats> {
  const name = indexName();
  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) return { configured: false, indexName: name };
  try {
    if (!(await indexExists(pc, pineconeSource, userId))) return { configured: true, indexName: name, exists: false };
    const stats = (await withRagApiHealth("pinecone", pineconeSource, userId, "describeIndexStats", () =>
      pc.Index(name).describeIndexStats()
    )) as {
        totalRecordCount?: number;
        totalVectorCount?: number;
        dimension?: number;
      };
    return {
      configured: true,
      indexName: name,
      exists: true,
      totalVectorCount: stats.totalRecordCount ?? stats.totalVectorCount ?? 0,
      dimension: stats.dimension
    };
  } catch (err) {
    return { configured: true, indexName: name, error: err instanceof Error ? err.message : String(err) };
  }
}

/** All Pinecone index totals visible to this key. Diagnostic-only: the RAG coverage
 * page is local-ledger based, so this exposes old/alternate indexes that can consume
 * the same org-level Pinecone quota while not appearing in ticker coverage. */
export async function getAllVectorStoreStats(userId: string = "local"): Promise<VectorIndexStats[]> {
  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) return [];
  try {
    const indexes = await withRagApiHealth("pinecone", pineconeSource, userId, "listIndexes", () => pc.listIndexes());
    const names = (indexes.indexes ?? []).map((i) => i.name).filter((name): name is string => Boolean(name));
    return Promise.all(
      names.map(async (name) => {
        try {
          const stats = (await withRagApiHealth("pinecone", pineconeSource, userId, "describeIndexStats", () =>
            pc.Index(name).describeIndexStats()
          )) as {
            totalRecordCount?: number;
            totalVectorCount?: number;
            dimension?: number;
          };
          return {
            indexName: name,
            totalVectorCount: stats.totalRecordCount ?? stats.totalVectorCount ?? 0,
            dimension: stats.dimension
          };
        } catch (err) {
          return { indexName: name, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
  } catch (err) {
    return [{ indexName: indexName(), error: err instanceof Error ? err.message : String(err) }];
  }
}

/**
 * server-asof-filter backfill (2026-07-06): pure per-vector decision for the idempotent backfill of
 * `as_of_epoch_ms` onto EXISTING vectors. Given one vector's current metadata, decide what to do:
 *
 *  - `"skip-has-epoch"`: the vector already carries a (finite numeric) `as_of_epoch_ms` — idempotent
 *    no-op, so re-running the backfill never re-writes it or costs a Pinecone update.
 *  - `"skip-undated"`: no `as_of_epoch_ms` AND no resolvable date in the acceptance_datetime ->
 *    published_at -> as_of -> timestamp chain — leave the field ABSENT (absence is the fail-open
 *    signal; we must NOT stamp 0/NaN onto a genuinely-undated vector).
 *  - `{ action: "update", epochMs }`: no epoch yet but a date resolves — set it via partial update.
 *
 * NaN-safe (reuses `resolveAsOfEpochMs`). No I/O — the orchestrator does the actual Pinecone update.
 */
export type BackfillEpochDecision =
  | { action: "skip-has-epoch" }
  | { action: "skip-undated" }
  | { action: "update"; epochMs: number };

export function computeBackfillEpochUpdate(metadata: Record<string, unknown> | undefined): BackfillEpochDecision {
  const existing = metadata?.[AS_OF_EPOCH_FIELD];
  // Idempotency: a vector already carrying a finite numeric epoch is left untouched. A non-numeric
  // or non-finite stray value is treated as "not set" so a corrupt write can be corrected by a re-run.
  if (typeof existing === "number" && Number.isFinite(existing)) return { action: "skip-has-epoch" };
  const epochMs = resolveAsOfEpochMs(metadata);
  if (epochMs == null) return { action: "skip-undated" };
  return { action: "update", epochMs };
}

export interface BackfillAsOfEpochResult {
  /** Total vectors scanned across all pages. */
  scanned: number;
  /** Vectors that already had a finite epoch (idempotent skips). */
  skippedHasEpoch: number;
  /** Vectors with no resolvable date — field intentionally left absent. */
  skippedUndated: number;
  /** Vectors updated with a freshly-derived epoch. */
  updated: number;
  /** Per-id update failures (non-fatal; the scan continues). */
  errors: number;
  /** True when `dryRun` was set — no `update` calls were issued, `updated` counts would-be updates. */
  dryRun: boolean;
}

export interface BackfillAsOfEpochOptions {
  /** userId whose resolved Pinecone key is used (default "local" = operator/env key). */
  userId?: string;
  /** When true, compute decisions and counts but issue NO Pinecone `update` calls. Default false. */
  dryRun?: boolean;
  /** Restrict the scan to ids under this prefix (Pinecone `listPaginated` prefix). Default: all ids. */
  prefix?: string;
  /** Vectors fetched per page (Pinecone fetch batch). Default 100. */
  batchSize?: number;
  /** Optional progress callback fired once per page with the running totals. */
  onProgress?: (progress: BackfillAsOfEpochResult) => void;
}

/**
 * server-asof-filter backfill orchestrator (2026-07-06): idempotently add `as_of_epoch_ms` to
 * EXISTING Pinecone vectors by recomputing the epoch from each vector's OWN date metadata
 * (acceptance_datetime/published_at/as_of/timestamp) and issuing a partial metadata update
 * (`index.update({ id, metadata: { as_of_epoch_ms } })`) for those lacking it. Vectors that already
 * have it are skipped (idempotent — safe to re-run), and genuinely-undated vectors are left absent.
 *
 * Iterates the whole index via Pinecone `listPaginated` (ids) + `fetch` (metadata) — no local chunk
 * ledger drives this because `document_chunks` stores content_hashes, not Pinecone vector ids, and
 * private-tier ids aren't enumerated there at all; listing the index is the authoritative source of
 * "every vector that exists". Per-id update failures are counted, not thrown, so one bad record
 * doesn't abort a long backfill. Returns aggregate counts for the operator/rollout note.
 */
export async function backfillAsOfEpoch(options: BackfillAsOfEpochOptions = {}): Promise<BackfillAsOfEpochResult> {
  const userId = options.userId ?? "local";
  const dryRun = Boolean(options.dryRun);
  const batchSize = Math.max(1, Math.min(1000, Math.floor(options.batchSize ?? 100)));
  const result: BackfillAsOfEpochResult = {
    scanned: 0,
    skippedHasEpoch: 0,
    skippedUndated: 0,
    updated: 0,
    errors: 0,
    dryRun
  };

  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) throw new Error("backfillAsOfEpoch: Pinecone key not configured");
  if (!(await indexExists(pc, pineconeSource, userId))) {
    throw new Error(`backfillAsOfEpoch: index "${indexName()}" does not exist`);
  }
  const index = pc.Index(indexName());

  let paginationToken: string | undefined;
  do {
    const listResp = await withRagApiHealth("pinecone", pineconeSource, userId, "list", () =>
      index.listPaginated({
        ...(options.prefix ? { prefix: options.prefix } : {}),
        ...(paginationToken ? { paginationToken } : {})
      })
    );
    const ids = (listResp.vectors ?? []).map((v) => v.id).filter((id): id is string => Boolean(id));
    paginationToken = listResp.pagination?.next;
    if (ids.length === 0) continue;

    // Fetch metadata in batches so a large page doesn't build one oversized fetch request.
    for (const idBatch of chunks(ids, batchSize)) {
      const fetchResp = await withRagApiHealth("pinecone", pineconeSource, userId, "fetch", () =>
        index.fetch({ ids: idBatch })
      );
      const records = fetchResp.records ?? {};
      for (const id of idBatch) {
        const record = records[id];
        if (!record) continue;
        result.scanned++;
        const decision = computeBackfillEpochUpdate(record.metadata as Record<string, unknown> | undefined);
        if (decision.action === "skip-has-epoch") {
          result.skippedHasEpoch++;
          continue;
        }
        if (decision.action === "skip-undated") {
          result.skippedUndated++;
          continue;
        }
        if (dryRun) {
          result.updated++;
          continue;
        }
        try {
          await withRagApiHealth("pinecone", pineconeSource, userId, "update", () =>
            index.update({ id, metadata: { [AS_OF_EPOCH_FIELD]: decision.epochMs } })
          );
          result.updated++;
        } catch (err) {
          result.errors++;
          console.warn(`[vector-db] backfillAsOfEpoch: update failed for id="${id}":`, err instanceof Error ? err.message : String(err));
        }
      }
    }
    options.onProgress?.({ ...result });
  } while (paginationToken);

  try {
    audit("vector_asof_epoch_backfill", { ...result }, userId);
  } catch {
    // best-effort telemetry only
  }
  return result;
}

export interface VectorMetadataInventoryRow {
  id: string;
  metadata: Record<string, unknown>;
}

/**
 * Authoritative provider-side metadata inventory. It lists Pinecone itself rather than trusting
 * local receipts, so receiptless crash ghosts are included. Callers must opt into this I/O by
 * invoking the function; importing the module performs no external work.
 */
export async function inventoryVectorRecordsByMetadata(options: {
  userId?: string;
  source?: string;
  docType?: string;
  receiptRequired?: boolean;
  batchSize?: number;
  /** Hard provider-record scan bound. Exceeding it throws rather than returning a partial inventory. */
  maxScanned?: number;
} = {}): Promise<VectorMetadataInventoryRow[]> {
  const userId = options.userId ?? "local";
  const batchSize = Math.max(1, Math.min(1_000, Math.floor(options.batchSize ?? 100)));
  const maxScanned = Math.max(1, Math.min(1_000_000, Math.floor(options.maxScanned ?? 250_000)));
  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) throw new Error("Pinecone key not configured for vector inventory.");
  if (!(await indexExists(pc, pineconeSource, userId))) return [];
  const index = pc.Index(indexName());
  const found: VectorMetadataInventoryRow[] = [];
  let scanned = 0;
  let paginationToken: string | undefined;
  do {
    const listed = await withRagApiHealth("pinecone", pineconeSource, userId, "inventory list", () =>
      index.listPaginated({ ...(paginationToken ? { paginationToken } : {}) })
    );
    paginationToken = listed.pagination?.next;
    const ids = (listed.vectors ?? []).map((row) => row.id).filter((id): id is string => Boolean(id));
    if (scanned + ids.length > maxScanned) {
      throw new Error(`Vector inventory scan limit exceeded (${maxScanned} records).`);
    }
    scanned += ids.length;
    for (const idBatch of chunks(ids, batchSize)) {
      const fetched = await withRagApiHealth("pinecone", pineconeSource, userId, "inventory fetch", () =>
        index.fetch({ ids: idBatch })
      );
      for (const id of idBatch) {
        const raw = fetched.records?.[id]?.metadata;
        const metadata = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        if (options.source !== undefined && metadata.source !== options.source) continue;
        if (options.docType !== undefined && String(metadata.doc_type ?? "").toLowerCase() !== options.docType.toLowerCase()) continue;
        if (options.receiptRequired !== undefined && metadata.receipt_required !== options.receiptRequired) continue;
        found.push({ id, metadata });
      }
    }
  } while (paginationToken);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

export async function purgeVectorRecordsByMetadata(options: {
  userId?: string;
  source?: string;
  docType?: string;
  receiptRequired?: boolean;
  dryRun?: boolean;
  batchSize?: number;
  maxScanned?: number;
}): Promise<{ dryRun: boolean; ids: string[]; deleted: number }> {
  const dryRun = options.dryRun !== false;
  const rows = await inventoryVectorRecordsByMetadata(options);
  const ids = rows.map((row) => row.id);
  if (dryRun || ids.length === 0) return { dryRun, ids, deleted: 0 };
  const userId = options.userId ?? "local";
  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) throw new Error("Pinecone key not configured for vector purge.");
  const index = pc.Index(indexName());
  const batchSize = Math.max(1, Math.min(1_000, Math.floor(options.batchSize ?? 100)));
  let deleted = 0;
  for (const idBatch of chunks(ids, batchSize)) {
    await withRagApiHealth("pinecone", pineconeSource, userId, "rights purge delete", () =>
      index.deleteMany({ ids: idBatch })
    );
    deleted += idBatch.length;
  }
  return { dryRun, ids, deleted };
}

/**
 * Repair or delete managed crash leftovers. Provider-committed vectors are replayed only when an
 * exact local receipt set exists; every other managed provider ghost is deleted. Defaults to a
 * deterministic dry run.
 */
export async function reconcileManagedVectorRecords(options: {
  userId?: string;
  source?: string;
  dryRun?: boolean;
} = {}): Promise<{
  dryRun: boolean;
  promoteIds: string[];
  deleteIds: string[];
  promoted: number;
  deleted: number;
}> {
  const dryRun = options.dryRun !== false;
  const userId = options.userId ?? "local";
  const providerRows = await inventoryVectorRecordsByMetadata({
    userId,
    receiptRequired: true
  });
  const database = dbModule.getDb();
  const commitRows = database.prepare(`
    SELECT id, source, accession, expected_vectors, state
    FROM vector_ingest_commits
    WHERE state IN ('pending','receipts_persisted','committed')
      ${options.source === undefined ? "" : "AND source = ?"}
  `).all(...(options.source === undefined ? [] : [options.source])) as Array<{
    id: string;
    source: string;
    accession: string;
    expected_vectors: number;
    state: string;
  }>;
  const commits = new Map(commitRows.map((row) => [row.id, row]));
  const localRows = database.prepare(`
    SELECT o.vector_id, o.commit_id, o.content_version, o.tenant_scope,
           o.source, o.accession,
           o.receipt_state, c.state AS commit_state
    FROM chunk_occurrences o
    JOIN vector_ingest_commits c ON c.id = o.commit_id
    WHERE o.receipt_state IN ('pending','committed')
      ${options.source === undefined ? "" : "AND c.source = ?"}
  `).all(...(options.source === undefined ? [] : [options.source])) as Array<{
    vector_id: string;
    commit_id: string;
    content_version: string;
    tenant_scope: string;
    source: string;
    accession: string;
    receipt_state: string;
    commit_state: string;
  }>;
  const local = new Map(localRows.map((row) => [row.vector_id, row]));
  const localByCommit = new Map<string, typeof localRows>();
  for (const row of localRows) {
    const grouped = localByCommit.get(row.commit_id) ?? [];
    grouped.push(row);
    localByCommit.set(row.commit_id, grouped);
  }
  const providerByCommit = new Map<string, VectorMetadataInventoryRow[]>();
  const consideredProviderRows: VectorMetadataInventoryRow[] = [];
  for (const providerRow of providerRows) {
    const metadata = providerRow.metadata;
    const commitId = typeof metadata.vector_commit_id === "string" ? metadata.vector_commit_id : "";
    // A source-scoped repair still inventories every managed record so a row whose source metadata
    // was corrupted cannot escape merely by no longer matching the requested source. Unrelated
    // commits remain untouched.
    if (
      options.source !== undefined &&
      metadata.source !== options.source &&
      !commits.has(commitId)
    ) continue;
    consideredProviderRows.push(providerRow);
    const grouped = providerByCommit.get(commitId) ?? [];
    grouped.push(providerRow);
    providerByCommit.set(commitId, grouped);
  }
  const promoteRows: VectorMetadataInventoryRow[] = [];
  const deleteRows: VectorMetadataInventoryRow[] = [];
  const commitsToFinalize = new Set<string>();
  for (const providerRow of consideredProviderRows) {
    const metadata = providerRow.metadata;
    const commitId = typeof metadata.vector_commit_id === "string" ? metadata.vector_commit_id : "";
    const commit = commits.get(commitId);
    const receipt = local.get(providerRow.id);
    const providerGroup = providerByCommit.get(commitId) ?? [];
    const localGroup = localByCommit.get(commitId) ?? [];
    const exactRow = Boolean(
      commit && receipt &&
      metadata.vector_commit_id === receipt.commit_id &&
      metadata.content_version === receipt.content_version &&
      metadata.tenant_scope === receipt.tenant_scope &&
      metadata.source === commit.source &&
      metadata.accession === commit.accession &&
      receipt.source === commit.source &&
      receipt.accession === commit.accession
    );
    const exactSet = Boolean(
      commit &&
      (commit.state === "receipts_persisted" || commit.state === "committed") &&
      localGroup.length === commit.expected_vectors &&
      providerGroup.length === commit.expected_vectors &&
      providerGroup.every((candidate) => {
        const candidateReceipt = local.get(candidate.id);
        return Boolean(
          candidateReceipt &&
          candidate.metadata.vector_commit_id === commitId &&
          candidate.metadata.content_version === candidateReceipt.content_version &&
          candidate.metadata.tenant_scope === candidateReceipt.tenant_scope &&
          candidate.metadata.source === commit.source &&
          candidate.metadata.accession === commit.accession &&
          candidateReceipt.source === commit.source &&
          candidateReceipt.accession === commit.accession
        );
      }) &&
      localGroup.every((candidate) => providerGroup.some((row) => row.id === candidate.vector_id))
    );
    if (!exactRow || !exactSet) {
      deleteRows.push(providerRow);
      continue;
    }
    if (metadata.ingest_state !== "committed") promoteRows.push(providerRow);
    if (commit?.state === "receipts_persisted") commitsToFinalize.add(commitId);
  }
  const promoteIds = promoteRows.map((row) => row.id).sort();
  const deleteIds = deleteRows.map((row) => row.id).sort();
  if (dryRun) return { dryRun, promoteIds, deleteIds, promoted: 0, deleted: 0 };

  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) throw new Error("Pinecone key not configured for vector reconciliation.");
  const index = pc.Index(indexName());
  for (const row of promoteRows) {
    await withRagApiHealth("pinecone", pineconeSource, userId, "reconcile commit", () =>
      index.update({ id: row.id, metadata: { ingest_state: "committed" } })
    );
  }
  // Finalize only after the complete expected provider set was observed. A partial provider set
  // is deleted above and remains locally non-queryable until the deterministic ingest retries.
  for (const commitId of commitsToFinalize) dbModule.markVectorCommitCommitted(commitId);
  let deleted = 0;
  for (const idBatch of chunks(deleteIds, 100)) {
    await withRagApiHealth("pinecone", pineconeSource, userId, "reconcile delete orphan", () =>
      index.deleteMany({ ids: idBatch })
    );
    deleted += idBatch.length;
  }
  return { dryRun, promoteIds, deleteIds, promoted: promoteIds.length, deleted };
}

export interface RetrievedChunk {
  /** Real Pinecone vector id (NOT a fabricated `<SYMBOL>#i`). */
  id: string;
  text: string;
  score: number;
  source?: string;
  /** The chunk's own acceptance_datetime/timestamp (NOT the query's as_of). */
  as_of?: string;
  doc_type?: string;
  section?: string;
  url?: string;
  /** 'shared' for public/shared-tier docs, 'private' for user-private docs. Undefined for legacy pre-scope vectors. */
  scope?: VectorScope;
  /**
   * Voyage cross-encoder relevance score from the rerank step (distinct from `score`, which is
   * Pinecone cosine similarity). Only present when reranking ran AND returned a score for this
   * chunk — undefined when rerank is off, failed, or the reranker didn't return `relevanceScore`.
   */
  relevanceScore?: number;
  /**
   * Raw Pinecone metadata for this chunk, with the (large, already-surfaced-as-`text`) `text`
   * field omitted (2026-07-04 episodic-retrieval lane, additive). Lets memory-aware callers read
   * fields the typed surface doesn't lift (e.g. `run_id` for same-run exclusion, `return_pct` for
   * counterexample labeling) without vector-db needing to know every memory schema. Undefined only
   * when the match carried no metadata at all.
   */
  metadata?: Record<string, unknown>;
}

/** Map a raw Pinecone match to a chunk carrying REAL provenance (id, score, acceptance date, url). */
export function matchToChunk(match: any): RetrievedChunk {
  const md = (match?.metadata ?? {}) as Record<string, unknown>;
  const asOf = md.acceptance_datetime ?? md.as_of ?? md.timestamp;
  const rawScope = md.scope;
  const scope: VectorScope | undefined =
    rawScope === SHARED_SCOPE || rawScope === PRIVATE_SCOPE ? rawScope : undefined;
  const rerankScore = (match as { _rerankScore?: unknown } | undefined)?._rerankScore;
  // Metadata passthrough (episodic-retrieval lane): everything except the large `text` field,
  // which is already surfaced as `chunk.text`. Only attached when the match had metadata.
  const metadataRest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(md)) {
    if (key !== "text") metadataRest[key] = value;
  }
  return {
    id: String(match?.id ?? ""),
    text: typeof md.text === "string" ? md.text : "",
    score: typeof match?.score === "number" ? match.score : 0,
    source: typeof md.source === "string" ? md.source : undefined,
    as_of: asOf != null ? String(asOf) : undefined,
    doc_type: typeof md.doc_type === "string" ? md.doc_type : undefined,
    section: typeof md.section === "string" ? md.section : undefined,
    url: typeof md.url === "string" ? md.url : typeof md.filingUrl === "string" ? md.filingUrl : undefined,
    scope,
    ...(typeof rerankScore === "number" ? { relevanceScore: rerankScore } : {}),
    ...(match?.metadata != null ? { metadata: metadataRest } : {})
  };
}

/**
 * Compact provenance header (2026-07-04 RAG quick-wins, composite review "Provenance headers +
 * stable chunk ids on retrieved chunks"): `strategy.ts` used to join raw chunk text with no
 * indication of doc_type/section/date/relevance, so the model had no signal to weight a fresh 8-K
 * over a stale 10-K, and no visible reference to cite back. Prefixing each chunk with
 * `[10-K · risk-factors · AAPL · 2026-02-01 · rel 0.82]` gives the model exactly that signal inline
 * with the text it's reading, using data `RetrievedChunk` already carries (doc_type/section/as_of/
 * score/relevanceScore) — no new retrieval work. Chunk ids (`RetrievedChunk.id`, the real Pinecone
 * vector id) are already stable/real (see `matchToChunk`) and are NOT part of this text header —
 * they travel alongside it (`SocraticRagAttribution.chunkId`, orchestrator's `chunk_id`) for a
 * future `evidenceRefs` citation mechanism to key off.
 *
 * Date is truncated to YYYY-MM-DD (a citation header doesn't need sub-day precision); relevance
 * prefers the post-rerank `relevanceScore` (Voyage cross-encoder, the more meaningful "is this
 * actually relevant" signal) and falls back to the Pinecone cosine `score` when rerank didn't run.
 * Any missing field is simply omitted rather than rendered as a placeholder — a header for
 * unenriched legacy metadata still degrades gracefully instead of showing "undefined".
 */
export function formatChunkWithProvenance(chunk: RetrievedChunk, symbol?: string): string {
  const parts: string[] = [];
  if (chunk.doc_type) parts.push(chunk.doc_type.toUpperCase());
  if (chunk.section) parts.push(chunk.section);
  const sym = symbol ? canonicalTicker(symbol) : "";
  if (sym) parts.push(sym);
  if (chunk.as_of) {
    const dateOnly = String(chunk.as_of).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) parts.push(dateOnly);
  }
  const relevance = chunk.relevanceScore ?? chunk.score;
  if (typeof relevance === "number" && Number.isFinite(relevance)) parts.push(`rel ${relevance.toFixed(2)}`);
  if (parts.length === 0) return chunk.text;
  return `[${parts.join(" · ")}]\n${chunk.text}`;
}

/**
 * Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06): `retrieveContextDetailed`
 * already computes four distinct reasons an empty (or quality-degraded) result can occur, but
 * previously only surfaced them as Sentry-only warning strings — every caller saw an
 * indistinguishable `[]`/non-empty result. This union names them for callers that opt in via
 * `RetrieveOptions.onStatus`; it is a RECEIPT ONLY and must never gate/alter which chunks are
 * returned (owner philosophy: advisory-only, see AGENTS.md).
 *  - "ok": normal path, chunks returned (possibly empty via `no_memory`, see below).
 *  - "no_memory": pipeline ran cleanly but found zero matching chunks (real empty corpus/query).
 *  - "lookup_failed": missing Pinecone/Voyage keys, or the pipeline threw (outer catch).
 *  - "budget_skipped": skipped before any Voyage/Pinecone call because the daily LLM/RAG budget
 *    (isOverLlmBudget) was already exceeded.
 *  - "degraded": the per-run RAG budget (R16 shouldDegradeForBudget) tripped, so rerank/hybrid were
 *    skipped but core dense-cosine recall still ran — NON-empty, just lower quality.
 */
export type RetrievalStatus = "ok" | "no_memory" | "lookup_failed" | "budget_skipped" | "degraded";

/**
 * Retrieve relevant chunks from Pinecone with REAL provenance (id/score/as_of/url) so answers can
 * be grounded and honestly cited.
 */
export interface RetrieveOptions {
  /** Point-in-time guard: drop chunks whose acceptance_datetime is after this ISO date. */
  asOf?: string;
  /** The account being run, so the RAG budget guard resolves THAT account's ceiling (not the active
   *  account's) in a multi-account scheduler run. Omit for the active-account default (unchanged). */
  connectedAccountId?: string;
  /**
   * Restrict account-derived vector memory to the exact connected account. This is deliberately
   * opt-in so public filings/fundamentals remain cross-account; episodic decision memory opts in.
   * Missing connectedAccountId under `exact` fails closed to an impossible sentinel match.
   */
  accountScope?: "exact";
  /** Restrict to these document types (metadata.doc_type), e.g. ["10-k","10-q"]. */
  docType?: string[];
  /**
   * When true, drop the `symbol == <symbol arg>` metadata clause so retrieval spans ALL symbols
   * (2026-07-04 episodic-retrieval lane, additive). Episodic decision analogs are cross-symbol by
   * design — the same setup on a different ticker is exactly the prior worth surfacing. Default
   * false/omitted = existing per-symbol behavior, byte-for-byte unchanged for every current caller.
   */
  matchAllSymbols?: boolean;
  /** Restrict to a specific filing section (metadata.section). */
  section?: string;
  /** Restrict to a specific source (metadata.source), e.g. "sec-8k". */
  source?: string;
  /** Drop matches whose cosine score is below this (0–1). Applied before reranking. */
  minScore?: number;
  /**
   * Post-rerank relevance floor (0–1): drop chunks whose Voyage cross-encoder `relevanceScore` is
   * below this, applied AFTER reranking. Default-off/opt-in — omitted (or rerank not running)
   * means no post-rerank filtering, so current behavior is byte-for-byte unchanged unless a caller
   * sets this. Has no effect when reranking is disabled or failed (no relevanceScore to filter on).
   */
  minRelevanceScore?: number;
  /**
   * R12 (2026-07-01 RAG backlog): when true (or RAG_APPLY_DEFAULT_FLOORS is truthy) AND `minScore`
   * was NOT explicitly set, applies `defaultMinScore()` (VECTOR_MIN_SCORE, default 0.30) as the
   * cosine floor instead of leaving it unset. `defaultMinScore()` has existed since before this
   * item as a helper that only `strategy.ts`/`orchestrator.ts` remembered to call explicitly — any
   * OTHER/new caller of `retrieveContextDetailed` silently got NO floor. This option closes that
   * gap for new callers without changing either existing call site (both already pass `minScore`
   * explicitly, so `options.minScore == null` is false for them and this option is a no-op).
   * Floor-only: does NOT change reranking behavior on small pools (a full-pool result set is
   * returned regardless of cosine ordering, so there was never a meaningful "run rerank on small
   * pools" half to this item — see the RAG expansion doc R12 for why that half was dropped).
   */
  applyDefaultFloors?: boolean;
  /**
   * R14 (2026-07-01 RAG backlog): opt-in near-duplicate suppression (0-1 Jaccard-shingle
   * threshold) applied after reranking/floors but before the final top-`limit` slice. See
   * `RankPoolOptions.dedupeSimilarity` for the exact pipeline placement. Omitted = current
   * behavior (no dedup pass, near-identical chunks can all appear in the final context).
   */
  dedupeSimilarity?: number;
  /**
   * HyDE + evidence-derived multi-query retrieval (hyde-multiquery-retrieval, 2026-07-05).
   * When present (and non-empty), `retrieveContextDetailed` embeds EACH query independently (via
   * the same query-embed cache as the single-query path), runs a separate Pinecone match per
   * query, and RRF-fuses the per-query ranked id lists into one candidate pool BEFORE the existing
   * `rankPool` pipeline (hybrid/rerank/floors/dedup) runs, unchanged. The primary `query` argument
   * is still used for hybrid BM25 fusion and rerank scoring; `queries` only affects which Pinecone
   * matches are recalled. Omitted/empty = current single-query behavior, byte-for-byte unchanged.
   */
  queries?: string[];
  /**
   * persist-candidate-pool (2026-07-06): current strategy run id, threaded through purely so an
   * opt-in candidate-pool persistence record (see rag/candidate-pool.ts, RAG_PERSIST_CANDIDATE_POOL)
   * can be joined back to the run that produced it. Additive/optional — omitted has zero effect on
   * retrieval behavior either way.
   */
  runId?: string;
  /**
   * Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06, additive/optional). When
   * supplied, invoked exactly once with the classified `RetrievalStatus` before `retrieveContextDetailed`
   * returns. Fire-and-forget from the callee's perspective — a throwing callback is swallowed so it
   * can never break retrieval; never used to alter chunk selection. Omitted = current behavior,
   * byte-for-byte unchanged (no callback invoked, no extra work performed).
   */
  onStatus?: (status: RetrievalStatus) => void;
}

/** Invoke `options?.onStatus` best-effort; a throwing callback must never affect retrieval. */
function reportRetrievalStatus(options: RetrieveOptions | undefined, status: RetrievalStatus): void {
  if (!options?.onStatus) return;
  try {
    options.onStatus(status);
  } catch {
    // advisory receipt only — never let a callback failure affect retrieval
  }
}

/**
 * Build the optional metadata-filter clauses (doc_type/section/source) shared by both tiers.
 *
 * doc_type is now normalized to lowercase AT WRITE TIME (cleanMetadata), so new vectors are
 * consistent. This still expands every casing variant at query time — NOT simplified to an
 * exact-match — because vectors written before that normalization landed may still carry
 * mixed/upper case (e.g. "10-K") and Pinecone `$in` is exact-match; dropping the variant expansion
 * would silently exclude that legacy data, which is worse than the (cheap) redundant variants.
 */
const EARNINGS_TRANSCRIPT_DOC_TYPE = "earnings-transcript";
const RIGHTS_BLOCKED_DOC_TYPE = "__earnings_transcript_rights_unconfirmed__";

function docTypeVariants(docTypes: string[]): string[] {
  return Array.from(new Set(docTypes.flatMap((docType) => [docType, docType.toLowerCase(), docType.toUpperCase()])));
}

export function buildExtraFilters(options?: RetrieveOptions): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const transcriptRightsConfirmed = envFlagOn("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", false);
  if (options?.docType && options.docType.length > 0) {
    const allowedDocTypes = transcriptRightsConfirmed
      ? options.docType
      : options.docType.filter((docType) => docType.toLowerCase() !== EARNINGS_TRANSCRIPT_DOC_TYPE);
    extra.doc_type = allowedDocTypes.length > 0
      ? { $in: docTypeVariants(allowedDocTypes) }
      : { $eq: RIGHTS_BLOCKED_DOC_TYPE };
  }
  if (options?.section) extra.section = { $eq: options.section };
  if (options?.source) extra.source = { $eq: options.source };
  if (options?.accountScope === "exact") {
    extra.connected_account_id = { $eq: options.connectedAccountId ?? "__missing_connected_account__" };
  }
  return extra;
}

/**
 * Defense-in-depth for broad retrieval paths that do not send a doc_type filter. Pinecone documents
 * `$nin` but does not define how it treats legacy records where the field is absent; applying it to
 * every default query could therefore hide unrelated old corpus data. Explicit transcript requests
 * are blocked server-side by buildExtraFilters, while this post-fetch guard removes transcript
 * matches before ranking, persistence, or prompt injection without changing missing-field recall.
 */
export function filterMatchesForTranscriptRights<T extends { metadata?: Record<string, unknown> }>(matches: T[]): T[] {
  if (envFlagOn("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", false)) return matches;
  return matches.filter((match) => {
    const docType = match?.metadata?.doc_type;
    return typeof docType !== "string" || docType.toLowerCase() !== EARNINGS_TRANSCRIPT_DOC_TYPE;
  });
}

/**
 * Relational defense in depth for managed records. Pinecone metadata is not trusted by itself: a
 * result must match a locally committed occurrence, commit id, content version, and tenant scope
 * before it can enter ranking/candidate persistence. Any local validation fault drops managed
 * matches while retaining unrelated legacy/direct records.
 */
export function filterMatchesForCommittedReceipts<T extends {
  id?: string;
  metadata?: Record<string, unknown>;
}>(matches: T[]): T[] {
  const isManaged = (match: T): boolean => (
    match.metadata?.receipt_required === true ||
    typeof match.metadata?.vector_commit_id === "string" ||
    (typeof match.id === "string" && match.id.startsWith("occ:v2:"))
  );
  const managed = matches.filter(isManaged);
  if (managed.length === 0) return matches;
  const ids = managed.map((match) => typeof match.id === "string" ? match.id : "").filter(Boolean);
  try {
    const receipts = dbModule.committedManagedVectorReceipts(ids);
    return matches.filter((match) => {
      if (!isManaged(match)) return true;
      if (typeof match.id !== "string" || !match.id) return false;
      const metadata = match.metadata;
      if (!metadata) return false;
      const receipt = receipts.get(match.id);
      if (!receipt) return false;
      return (
        metadata.receipt_required === true &&
        metadata.ingest_state === "committed" &&
        metadata.vector_commit_id === receipt.commitId &&
        metadata.content_version === receipt.contentVersion &&
        metadata.tenant_scope === receipt.tenantScope &&
        metadata.content_hash === receipt.contentHash &&
        metadata.symbol === receipt.symbol &&
        metadata.source === receipt.source &&
        metadata.accession === receipt.accession &&
        metadata.section === receipt.section &&
        metadata.chunk_ordinal === receipt.ordinal &&
        metadata.parser_revision === receipt.parserRevision &&
        metadata.embed_revision === receipt.embedRevision
      );
    });
  } catch {
    return matches.filter((match) => !isManaged(match));
  }
}

export async function retrieveContextDetailed(
  query: string,
  symbol: string,
  limit: number = 3,
  userId: string = "local",
  options?: RetrieveOptions
): Promise<RetrievedChunk[]> {
  // Budget guard (durable spend primitive): when the user is over their daily LLM/RAG budget, skip
  // retrieval entirely — no Voyage embed, no Pinecone query, no metered spend. Returns empty like the
  // no-client case, so every caller degrades gracefully. Default OFF (no ceiling) → no-op.
  if (isOverLlmBudget(userId, options?.connectedAccountId)) {
    void captureRagSentryMessage("warning", "RAG retrieval skipped: daily LLM/RAG budget exceeded", {
      provider: "voyage",
      operation: "retrieveContext",
      source: userId === "local" ? "operator" : "user",
      connectedAccountId: options?.connectedAccountId ?? null
    });
    reportRetrievalStatus(options, "budget_skipped");
    return [];
  }
  const vectorUserId = vectorUserIdFor(userId);
  const { pc, voyage, pineconeSource, voyageSource } = await getClients(userId);
  if (!pc || !voyage) {
    void captureRagSentryMessage("warning", "RAG retrieval skipped: missing Pinecone or Voyage key", {
      provider: !pc ? "pinecone" : "voyage",
      operation: "retrieveContext",
      source: userId === "local" ? "operator" : "user"
    });
    reportRetrievalStatus(options, "lookup_failed");
    return [];
  }
  // R16 (2026-07-01 RAG backlog): default-off, very-high-ceiling per-run budget check. When
  // tripped, DEGRADE by skipping rerank/hybrid only — never core dense-cosine recall. A no-op
  // (always false) when RAG_RUN_BUDGET_ENABLED is off, so default behavior is unaffected.
  const budgetDegraded = shouldDegradeForBudget();
  if (budgetDegraded) {
    void captureRagSentryMessage("warning", "RAG retrieval degraded: per-run budget reached", {
      provider: "voyage",
      operation: "retrieveContext",
      source: userId === "local" ? "operator" : "user"
    });
  }
  const wantRerank = rerankEnabled() && !budgetDegraded;
  const wantHybrid = hybridRetrievalEnabled() && !budgetDegraded;
  // Over-fetch when we'll post-filter (as-of), rerank, OR hybrid-fuse — so the final top-`limit` is
  // high quality. Hybrid must be included even when rerank is off: otherwise fetchK == limit and the
  // BM25/RRF step only reorders the dense top-N, so an exact ticker/accession hit at dense rank
  // limit+1 is never in the pool and the recall gap the flag targets can't be recovered.
  // When reranking will actually run, use the wider env-tunable rerank-path cap (default 150) — the
  // cross-encoder is cheap to run over hundreds of candidates and a modest-50 cap otherwise hides a
  // flip-the-decision chunk at dense rank 51+ from ever reaching it. Non-rerank over-fetch (as-of or
  // hybrid alone) keeps the existing modest `overFetchK` cap — this does not change their Pinecone topK.
  const fetchK = wantRerank ? rerankOverFetchK(limit) : options?.asOf || wantHybrid ? overFetchK(limit) : limit;
  const extraFilter = buildExtraFilters(options);

  // server-asof-filter (2026-07-06): the optional server-side point-in-time clause. `undefined`
  // (asOf unset/unparseable, or VECTOR_ASOF_SERVER_FILTER off) means NO clause is added — the
  // filters below are then byte-identical to today. `mergeAsOfEpoch` AND-combines it with the
  // existing scope/symbol/docType filter (via `$and` when the base already carries a top-level `$or`,
  // so the fail-open epoch `$or` cannot collide with the scope-coexistence `$or`).
  const asOfEpochFilter = buildAsOfEpochFilter(options?.asOf, asOfStrictEnabled());

  try {
    if (!(await indexExists(pc, pineconeSource, userId))) {
      reportRetrievalStatus(options, "lookup_failed");
      return [];
    }

    const index = pc.Index(indexName());

    // Episodic cross-symbol mode (matchAllSymbols): omit the symbol clause entirely so decision
    // analogs on OTHER tickers stay retrievable. Default (unset) keeps the per-symbol restriction.
    const symbolFilter: Record<string, unknown> = options?.matchAllSymbols ? {} : { symbol: { $eq: symbol } };

    // The shared-tier filter uses $or to match BOTH new vectors (scope=='shared') and legacy
    // pre-scope vectors (userId=='local'). This is the backward-compat coexistence strategy:
    // scope is authoritative for new vectors; userId is the fallback for old ones.
    const sharedTierFilter = withCommittedVectorFilter(mergeAsOfEpoch({
      ...symbolFilter,
      ...extraFilter,
      $or: [
        { scope: { $eq: SHARED_SCOPE } },
        { userId: { $eq: "local" } }
      ]
    }, asOfEpochFilter));

    // Embed ONE query string (via the shared query-embed cache) and run its Pinecone match(es),
    // returning `null` on a malformed embedding (already audited/logged by the caller of `null`).
    // Factored out of the single-query path unchanged so `queries?.length` absent/empty is
    // byte-for-byte identical to pre-multi-query behavior (one embed, one match round-trip).
    const embedAndMatchOneQuery = async (q: string): Promise<any[] | null> => {
      // Query-embedding cache (consolidated R9 + G8b): a vector-only LRU keyed on the NORMALIZED
      // query (lowercase + collapsed whitespace) so trivial casing/spacing variants share a hit —
      // never Pinecone results (see query-embed-cache.ts for the full safety rationale). Default ON;
      // disable with RAG_QUERY_EMBED_CACHE=off. A hit skips the Voyage embed and its metering; a miss
      // embeds, meters under the REQUESTING userId (so retrieval spend counts toward that user's daily
      // LLM/RAG budget, not "local"), and books the per-run budget op.
      let embedding = getCachedQueryEmbedding(VOYAGE_MODEL, q);
      if (embedding == null) {
        const response = await withRagApiHealth(
          "voyage",
          voyageSource,
          userId,
          "embed query",
          () => embedWithRetry(voyage, [q], "query", undefined, voyageSource, userId),
          undefined,
          { durablyTrackedInside: true }
        );
        meterEmbed([q], undefined, userId); // count only on a cache MISS; book under the requesting userId
        recordRagOperation(); // R16: count this embed call against the per-run budget (no-op unless enabled).
        embedding = response.data?.[0]?.embedding;
      }
      // R2 integrity guard applies to the query embedding too: a malformed vector (wrong dimension,
      // NaN) would return garbage matches rather than a clean empty result. Audit so a Voyage
      // model/config drift is observable instead of silently returning bad matches.
      if (!isValidEmbedding(embedding)) {
        if (embedding != null) {
          const dim = Array.isArray(embedding as unknown) ? (embedding as unknown[]).length : "n/a";
          audit("vector_embedding_integrity", { rejected: 1, context: "query" }, userId);
          console.warn(`[vector-db] Rejected malformed query embedding (dim=${dim}).`);
          void captureRagSentryMessage("warning", "Voyage query embedding integrity rejection", {
            provider: "voyage",
            operation: "embed query",
            source: voyageSource,
            rejected: 1,
            dimension: String(dim)
          });
        }
        return null;
      }
      // Only cache a validated (finite, correctly-shaped) embedding — never a malformed one.
      setCachedQueryEmbedding(VOYAGE_MODEL, q, embedding);

      if (vectorUserId === "local") {
        const results = await withRagApiHealth("pinecone", pineconeSource, userId, "query", () =>
          index.query({
            vector: embedding,
            topK: fetchK,
            filter: sharedTierFilter,
            includeMetadata: true,
          })
        );
        const m = results.matches || [];
        meterPineconeQuery(pineconeReadUnits(results, 1), userId, m.length);
        return m;
      }

      // server-asof-filter: the user-tier filter gets the SAME epoch clause as the shared tier.
      // The fail-open epoch clause itself carries an `$or`, so it must go through `mergeAsOfEpoch`
      // (which promotes to `$and`) rather than a spread — a bare spread would be fine here (no
      // pre-existing top-level `$or`), but routing both tiers through one helper keeps them identical.
      const userTierFilter = withCommittedVectorFilter(mergeAsOfEpoch({
        ...symbolFilter,
        userId: { $eq: vectorUserId },
        ...extraFilter
      }, asOfEpochFilter));

      const [userResults, localResults] = await Promise.all([
        withRagApiHealth("pinecone", pineconeSource, userId, "query user tier", () =>
          index.query({
            vector: embedding,
            topK: fetchK,
            filter: userTierFilter,
            includeMetadata: true,
          })
        ),
        withRagApiHealth("pinecone", pineconeSource, userId, "query shared tier", () =>
          index.query({
            vector: embedding,
            topK: fetchK,
            filter: sharedTierFilter,
            includeMetadata: true,
          })
        )
      ]);
      meterPineconeQuery(
        pineconeReadUnits(userResults, 1) + pineconeReadUnits(localResults, 1),
        userId,
        (userResults.matches?.length ?? 0) + (localResults.matches?.length ?? 0)
      );

      const combined = [...(userResults.matches || []), ...(localResults.matches || [])];
      combined.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      const seenIds = new Set<string>();
      const unique: any[] = [];
      for (const m of combined) {
        if (m.id) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            unique.push(m);
          }
        } else {
          unique.push(m);
        }
      }
      return unique.slice(0, fetchK);
    };

    // Additive multi-query fan-out (hyde-multiquery-retrieval, 2026-07-05): when the caller passes
    // `options.queries` (a non-empty array — set behind RAG_MULTIQUERY/RAG_HYDE in strategy.ts),
    // embed + match EACH query independently (INCLUDING the caller's original `query`, so its dense
    // recall is augmented rather than replaced — 2026-07-05 review fix), then RRF-fuse the per-query
    // ranked id lists into one candidate pool before the existing rankPool pipeline. Absent/empty
    // `queries` runs the exact single-query path unchanged (same one embed, one match round-trip).
    //
    // Fail-OPEN, never fail-closed (2026-07-05 review fix): `embedAndMatchOneQuery` has no internal
    // catch and its callees (withRagApiHealth/embedWithRetry) rethrow on a transient Voyage/Pinecone
    // error, so a bare `Promise.all` here would let ONE variant's failure reject the whole fan-out —
    // dropping every OTHER variant's already-successful results along with it. Each fan-out call is
    // now individually caught (a rejected variant -> null, same "no result for this query" contract
    // as a malformed embedding); and if EVERY variant fails/fuses to nothing, we fall back to the
    // plain single-`query` path (i.e. behave exactly as flags-off) instead of returning `[]` — this
    // module's header promise ("always falls back to the caller's original single query, never
    // throws") only holds if this branch degrades that far, not just to an empty result.
    const fanOutQueries = (options?.queries ?? []).length > 0
      ? Array.from(new Set([query, ...(options!.queries as string[])]))
      : [];
    let matches: any[];
    if (fanOutQueries.length > 0) {
      const perQueryResults = await Promise.all(
        fanOutQueries.map(async (q) => {
          try {
            return await embedAndMatchOneQuery(q);
          } catch (err) {
            console.warn(`[vector-db] multi-query variant failed, dropping it from the fan-out:`, err instanceof Error ? err.message : String(err));
            return null;
          }
        })
      );
      const validResults = perQueryResults.filter((r): r is any[] => r != null && r.length > 0);
      if (validResults.length === 0) {
        // Every variant (including the original query, always included above) failed or matched
        // nothing — fall back to the plain single-query path rather than returning `[]`.
        const single = await embedAndMatchOneQuery(query);
        if (single == null) {
          reportRetrievalStatus(options, "lookup_failed");
          return [];
        }
        matches = single;
      } else {
        // Synthetic ids for matches lacking a real Pinecone id are scoped per-list-index (list N /
        // position i) so a missing id in one query's pool can never collide with a missing id at the
        // same position in a DIFFERENT query's pool — each stays its own distinct, unfused candidate.
        const rankedIdLists: string[][] = validResults.map((matchList, listIdx) =>
          matchList.map((m: any, i: number) => (typeof m?.id === "string" && m.id.length > 0 ? m.id : `__idx_${listIdx}_${i}__`))
        );
        // First-occurrence-wins would let a LOWER cosine score for a chunk that appears in multiple
        // per-query pools silently win the fused entry (feeding a lower score into rankPool's
        // minScore floor for that chunk). Keep the occurrence with the HIGHER match.score instead.
        const idToMatch = new Map<string, any>();
        validResults.forEach((matchList, listIdx) => {
          matchList.forEach((m: any, i: number) => {
            const id = rankedIdLists[listIdx]![i]!;
            const existing = idToMatch.get(id);
            if (!existing || (Number(m?.score) || 0) > (Number(existing?.score) || 0)) {
              idToMatch.set(id, m);
            }
          });
        });
        const fusedIds = rrfFuse(rankedIdLists);
        matches = fusedIds.map((id) => idToMatch.get(id)).filter((m): m is any => m !== undefined).slice(0, fetchK);
      }
    } else {
      const single = await embedAndMatchOneQuery(query);
      if (single == null) {
        reportRetrievalStatus(options, "lookup_failed");
        return [];
      }
      matches = single;
    }

    // Broad coach/chat retrieval has no docType filter. Enforce transcript rights before any
    // candidate-pool persistence, reranking, or prompt injection while preserving legacy matches
    // whose metadata predates doc_type.
    matches = filterMatchesForCommittedReceipts(matches);
    matches = filterMatchesForTranscriptRights(matches);

    // R12 (2026-07-01 RAG backlog): apply the default cosine floor for a caller that opted in via
    // `applyDefaultFloors`/RAG_APPLY_DEFAULT_FLOORS AND did not explicitly set `minScore`. Both
    // existing callers (strategy.ts, orchestrator.ts) already pass `minScore` explicitly, so
    // `options?.minScore == null` is false for them — this resolves to their explicit value,
    // unchanged, regardless of `applyDefaultFloors`.
    const wantDefaultFloors = Boolean(options?.applyDefaultFloors) || envFlagOn("RAG_APPLY_DEFAULT_FLOORS", false);
    const effectiveMinScore = options?.minScore ?? (wantDefaultFloors ? defaultMinScore() : undefined);

    // persist-pool-v2 (2026-07-06): the flag check happens BEFORE any work (no hook is even
    // constructed when off), mirroring v1's "no-op, not a suppressed write" posture — off means
    // `rankPool` gets no `onDispositions` at all, so it runs its exact pre-v2 pure-function path.
    const wantFullPool = candidatePoolFullPersistEnabled();
    let capturedDispositions: Map<string, CandidateDisposition> | undefined;

    // Review fix (2026-07-06): id-less rerank-survivor mislabel. `rerankMatches` returns a NEW
    // spread object `{ ...match, _rerankScore }` for every candidate Voyage assigns a numeric
    // relevanceScore to — including id-less ones — so an id-less match that SURVIVES rerank loses
    // its original object identity. The v2 capture block below used to key id-less matches purely
    // by identity (`finalSliceIdentitySet`/`rerankScoreByIdentity` built against the ORIGINAL
    // `matches` array), so a surviving-but-rerank-copied id-less match was invisible to both sets
    // and got mislabeled `dropped_rerank_truncate` with no relevanceScore. Fix: stamp a stable,
    // own-enumerable `__poolKey` string onto every id-less match BEFORE rankPool/rerank runs — a
    // plain spread (`{ ...match, ... }`) always copies own enumerable properties, so this key
    // survives rerank's copy intact and lets every downstream lookup key off `m.id || m.__poolKey`
    // instead of raw object identity. Only stamped when `wantFullPool` (v2 is the only consumer),
    // so retrieval is a true no-op — no extra property, no extra work — when the flag is off.
    if (wantFullPool) {
      matches.forEach((m, i) => {
        if (m != null && typeof m === "object" && !(typeof m.id === "string" && m.id.length > 0)) {
          Object.defineProperty(m, "__poolKey", { value: `__cand_${i}__`, enumerable: true, configurable: true, writable: true });
        }
      });
    }

    // Pipeline: cosine recall → score floor → point-in-time guard → hybrid fuse → cross-encoder
    // rerank → post-rerank floor → top-limit. Factored into the pure `rankPool` helper (R4,
    // 2026-07-01 expert-review follow-up) so a network-free regression test can drive the exact
    // same post-recall logic this call site uses, instead of re-implementing it in test code.
    const ordered = await rankPool(matches, query, limit, {
      minScore: effectiveMinScore,
      asOf: options?.asOf,
      minRelevanceScore: options?.minRelevanceScore,
      hybrid: wantHybrid,
      rerank: wantRerank ? (q, m, k) => rerankMatches(voyage, q, m, k, userId, voyageSource) : undefined,
      strictAsOf: asOfStrictEnabled(),
      dedupeSimilarity: options?.dedupeSimilarity,
      userId,
      onDispositions: wantFullPool ? (d) => { capturedDispositions = d; } : undefined
    });
    const finalSlice = ordered.slice(0, limit);
    // persist-candidate-pool (2026-07-06): capture the FULL post-recall/post-dedupe candidate pool
    // (every candidate that survived floor/asOf/hybrid/rerank/dedupe — including ones NOT making
    // this final top-`limit` slice), so "what did we retrieve but not inject" is analyzable later.
    // The flag check is the FIRST thing this block does, before any mapping/hashing, so this is a
    // true no-op (not just a suppressed write) when RAG_PERSIST_CANDIDATE_POOL is off — default
    // retrieval is byte-for-byte unchanged. Runs for both the single-query and the #822 fused
    // multi-query path alike, since `ordered` is already the one fused pool by this point.
    //
    // HONESTY NOTE (2026-07-06 hardening pass): this captures rankPool's OUTPUT pool (`ordered`) —
    // i.e. post floor/asOf/hybrid/rerank/dedupe. Candidates dropped UPSTREAM of `ordered` by
    // minScore/asOf/dedupe are NOT here; this only ever answers "of what survived the full quality
    // pipeline, what got cut by the final top-N slice". With the FLAGSHIP production caller
    // (strategy.ts's filings retrieval pass, ~line 719-731 — dedupeSimilarity=defaultDedupeSimilarity()
    // = 0.6 non-null, limit=3), both `dedupeSimilar` and `rerankMatches` already hard-cap their
    // output at `limit`, so in that default config `ordered.length <= limit` — `finalSlice ===
    // ordered` and every persisted row is `used:true`. The interesting minScore/asOf/dedupe drops
    // are simply invisible to this feature in exactly the path it's meant to illuminate; `used:false`
    // rows are rare/absent there. A v2 that instead captures the PRE-rankPool `matches` pool with a
    // per-stage drop reason (minScore / asOf / dedupe / final-slice) is the real follow-up if "why
    // did we drop this candidate" is the actual goal — see docs/rollouts/2026-07-06-persist-candidate-pool.md.
    // Review fix (2026-07-06): capture-never-breaks-retrieval guard. This whole block runs BEFORE
    // the `return finalChunks` below, and was previously protected only by `retrieveContextDetailed`'s
    // OUTER catch — which returns `[]`. That means a throw ANYWHERE in this observability capture
    // (mapping, hashing, the id-less key computation, etc.) would silently turn a SUCCESSFUL
    // retrieval into an empty result, which is exactly backwards for an advisory-only feature. Wrap
    // the whole block in its own try/catch that swallows any throw so retrieval proceeds normally
    // regardless — `recordCandidatePool` itself already has an internal try/catch around the
    // `audit()` call, but this defends the mapping/key-computation code ABOVE that call too.
    try {
      if (candidatePoolPersistEnabled()) {
        // Id-less collision hardening (2026-07-06 hardening pass): a Pinecone match without a real
        // `id` would otherwise key on the literal empty string `""`, so multiple id-less matches in
        // `ordered` would collapse onto the same `finalIds` membership test and a non-sliced id-less
        // candidate could be mislabeled `used:true` just because SOME id-less candidate happened to
        // land in `finalSlice`. Mirror the #822 fan-out fusion code's guard above (`rankedIdLists`):
        // when a match's id is empty, use a per-position synthetic key instead, scoped to `ordered`'s
        // own indices so it won't collide with another id-less candidate. (Pinecone ids are arbitrary
        // strings, so a real id shaped like `__cand_${i}__` is not impossible — just vanishingly
        // unlikely; this guard disambiguates id-less matches, it is not a hard uniqueness proof.)
        const orderedKeys = ordered.map((m, i) => (typeof m?.id === "string" && m.id.length > 0 ? m.id : `__cand_${i}__`));
        const finalSliceKeySet = new Set(orderedKeys.slice(0, finalSlice.length));
        recordCandidatePool(
          {
            runId: options?.runId,
            symbol,
            queryHash: hashQuery(query),
            asOf: options?.asOf,
            candidates: ordered.map((m, i) => {
              const md = (m?.metadata ?? {}) as Record<string, unknown>;
              const asOfStamp = md.acceptance_datetime ?? md.as_of ?? md.timestamp;
              const rerankScore = (m as { _rerankScore?: unknown } | undefined)?._rerankScore;
              const key = orderedKeys[i]!;
              const id = String(m?.id ?? "");
              return {
                id,
                score: typeof m?.score === "number" ? m.score : undefined,
                ...(typeof rerankScore === "number" ? { relevanceScore: rerankScore } : {}),
                ...(typeof md.doc_type === "string" ? { docType: md.doc_type } : {}),
                ...(asOfStamp != null ? { asOf: String(asOfStamp) } : {}),
                used: finalSliceKeySet.has(key)
              };
            })
          },
          userId
        );
      }
    } catch (captureErr) {
      // Advisory capture only — never let a throw here affect retrieval. Best-effort log, never
      // re-thrown.
      console.warn("[vector-db] candidate-pool v1 capture failed (ignored, retrieval unaffected):", captureErr instanceof Error ? captureErr.message : String(captureErr));
    }

    // persist-pool-v2 (2026-07-06): capture the PRE-`rankPool` `matches` pool (raw Pinecone
    // recall, or the #822 fused pool when multi-query fan-out ran — either way, ONE record for the
    // whole call, matching v1's "one record per retrieveContextDetailed call" contract) together
    // with the per-candidate DISPOSITION `rankPool` computed via `onDispositions` above. This is
    // what actually answers "why did we drop this candidate": v1 only ever sees `ordered` (post
    // floor/asOf/hybrid/rerank/dedupe), so a minScore/asOf/dedupe/rerank-truncate drop is invisible
    // to it; here every candidate in `matches` gets exactly one disposition, including the ones v1
    // can never show. Flag-gated by a DISTINCT flag (RAG_PERSIST_CANDIDATE_POOL_FULL, checked via
    // `wantFullPool` above BEFORE `rankPool` even runs) so v1/v2 toggle independently; `wantFullPool`
    // false means `capturedDispositions` stays undefined and this block is a pure no-op.
    // Review fix (2026-07-06): capture-never-breaks-retrieval guard, same posture as the v1 block
    // above (defense in depth — both blocks run before `return finalChunks` and were previously
    // protected only by the function's OUTER catch, which returns `[]`; a throw anywhere in this
    // mapping/key-computation code must never turn a successful retrieval into an empty one).
    try {
      if (wantFullPool && capturedDispositions) {
        const dispositions = capturedDispositions;
        // Review fix (2026-07-06): key EVERY lookup below (final-slice membership AND relevanceScore
        // recovery) off `m.id || m.__poolKey` instead of splitting real-id-vs-object-identity. The
        // previous identity-based split was wrong for an id-less match that SURVIVES rerank: Voyage
        // assigns it a numeric relevanceScore, so `rerankMatches` returns a NEW spread object
        // `{ ...match, _rerankScore }` for it — same as a real-id match — which is no longer `===`
        // its pre-rerank original. That made it invisible to both `finalSliceIdentitySet` and
        // `rerankScoreByIdentity` (built against the ORIGINAL matches array), so it was mislabeled
        // `dropped_rerank_truncate` with no relevanceScore even though it was actually `used`.
        // `__poolKey` is stamped onto every id-less match BEFORE rankPool/rerank runs (see above,
        // only when `wantFullPool`) as an own-enumerable string property, which a plain object spread
        // always copies — so it survives rerank's copy intact, giving every id-less match a stable
        // key exactly like a real Pinecone `id` would. Same key scheme `rankPool`'s own `resolveKey`
        // uses internally (`m.id` when non-empty, else a synthetic per-original-index key), so this
        // stays in the same key space `dispositions` was built in.
        const keyOf = (m: any): string =>
          typeof m?.id === "string" && m.id.length > 0
            ? m.id
            : typeof m?.__poolKey === "string" && m.__poolKey.length > 0
              ? m.__poolKey
              : "";
        const matchKeys = matches.map((m, i) => {
          const k = keyOf(m);
          return k.length > 0 ? k : `__cand_${i}__`;
        });
        // Final-slice membership: a `finalSlice` entry may be a rerank-produced spread copy (new
        // object reference, same `id`/`__poolKey` FIELD) — always compare by key, never by `===`.
        const finalSliceKeySet = new Set(finalSlice.map((m) => keyOf(m)).filter((k) => k.length > 0));
        // `rerankMatches` (when it ran) returns NEW spread objects carrying `_rerankScore` — the
        // ORIGINAL `matches` entry never has that field. Recover it from `ordered` (rankPool's
        // return value, which IS the post-rerank pool) keyed the same way, so a candidate that
        // survived to be reranked reports its real relevanceScore instead of silently omitting it.
        const rerankScoreByKey = new Map<string, number>();
        for (const m of ordered) {
          const s = (m as { _rerankScore?: unknown } | undefined)?._rerankScore;
          if (typeof s !== "number") continue;
          const k = keyOf(m);
          if (k.length > 0) rerankScoreByKey.set(k, s);
        }
        // `used` is a strictly finer-grained disposition than `kept_not_used`: rankPool can only ever
        // report a survivor as `kept_not_used` (it doesn't know the caller's final top-`limit`
        // slice) — upgrade the ones actually present in `finalSlice` here, mirroring v1's
        // `finalSliceKeySet` upgrade logic but against the PRE-rankPool `matches` pool.
        recordCandidatePoolFull(
          {
            runId: options?.runId,
            symbol,
            queryHash: hashQuery(query),
            asOf: options?.asOf,
            candidates: matches.map((m, i) => {
              const md = (m?.metadata ?? {}) as Record<string, unknown>;
              const asOfStamp = md.acceptance_datetime ?? md.as_of ?? md.timestamp;
              const key = matchKeys[i]!;
              // Persisted `id` is ALWAYS the real Pinecone id (or "" when absent) — `__poolKey` is a
              // purely internal disambiguation key and must never leak into the persisted payload.
              const id = String(m?.id ?? "");
              const inFinalSlice = finalSliceKeySet.has(key);
              const rerankScore = rerankScoreByKey.get(key);
              const stageDisposition = dispositions.get(key);
              const disposition: CandidateDisposition = stageDisposition === "kept_not_used" && inFinalSlice
                ? "used"
                : (stageDisposition ?? "kept_not_used");
              return {
                id,
                score: typeof m?.score === "number" ? m.score : undefined,
                ...(typeof rerankScore === "number" ? { relevanceScore: rerankScore } : {}),
                ...(typeof md.doc_type === "string" ? { docType: md.doc_type } : {}),
                ...(asOfStamp != null ? { asOf: String(asOfStamp) } : {}),
                disposition
              };
            })
          },
          userId
        );
      }
    } catch (captureErr) {
      // Advisory capture only — never let a throw here affect retrieval. Best-effort log, never
      // re-thrown.
      console.warn("[vector-db] candidate-pool v2 capture failed (ignored, retrieval unaffected):", captureErr instanceof Error ? captureErr.message : String(captureErr));
    }
    const finalChunks = finalSlice
      .map(matchToChunk)
      .filter((c) => c.text);
    // Final status classification (receipt only — never changes `finalChunks`): a real zero-match
    // result is "no_memory" (pipeline ran cleanly, nothing relevant found); a non-empty result under
    // the R16 per-run budget degrade is "degraded" (lower quality, not absent); everything else "ok".
    reportRetrievalStatus(options, finalChunks.length === 0 ? "no_memory" : budgetDegraded ? "degraded" : "ok");
    return finalChunks;
  } catch (err) {
    console.error("[vector-db] Error retrieving context:", err);
    if (!wasRagSentryCaptured(err)) {
      await captureRagSentryMessage("error", "RAG retrieval failed", {
        provider: "pinecone",
        operation: "retrieveContext",
        source: userId === "local" ? "operator" : "user",
        symbol,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
    reportRetrievalStatus(options, "lookup_failed");
    return [];
  }
}

/**
 * Thin convenience wrapper (typed-retrieval-status, 2026-07-06) for callers that want the typed
 * status alongside the chunks without wiring their own `onStatus` callback. Purely additive — does
 * not change `retrieveContextDetailed` itself, and a caller-supplied `options.onStatus` (if any)
 * still fires exactly as it would calling `retrieveContextDetailed` directly.
 */
export async function retrieveContextDetailedWithStatus(
  query: string,
  symbol: string,
  limit: number = 3,
  userId: string = "local",
  options?: RetrieveOptions
): Promise<{ chunks: RetrievedChunk[]; status: RetrievalStatus }> {
  let status: RetrievalStatus = "ok";
  const chunks = await retrieveContextDetailed(query, symbol, limit, userId, {
    ...options,
    onStatus: (s) => {
      status = s;
      // Forward to the caller-supplied callback best-effort — a throwing callback must never
      // break retrieval. This mirrors the same guarantee `reportRetrievalStatus` already gives
      // internally; guarded explicitly here too since this closure is itself what gets invoked
      // through that internal call chain, and a receipt callback must never propagate a throw.
      try {
        options?.onStatus?.(s);
      } catch {
        // advisory receipt only — never let a callback failure affect retrieval
      }
    }
  });
  return { chunks, status };
}

/** Injectable rerank function shape `rankPool` accepts — matches `rerankMatches`'s signature minus the `voyage` client. */
export type RankPoolRerankFn = (query: string, matches: any[], topK: number) => Promise<any[]>;

export interface RankPoolOptions {
  /** Drop matches whose cosine score is below this (0–1). Applied first, before any reordering. */
  minScore?: number;
  /** Point-in-time guard: drop chunks whose resolved date stamp is after this ISO date. */
  asOf?: string;
  /** Post-rerank relevance floor (0–1), applied after rerank/hybrid but before the final slice. */
  minRelevanceScore?: number;
  /** Whether hybrid BM25/RRF fusion should run (caller resolves the env flag). */
  hybrid?: boolean;
  /** Injectable reranker; omit (or pass undefined) to skip reranking entirely (matches `wantRerank=false`). */
  rerank?: RankPoolRerankFn;
  /** R1 strict as-of mode (caller resolves `VECTOR_ASOF_STRICT`) — only has an effect when `asOf` is set. */
  strictAsOf?: boolean;
  /** userId for the strict-mode drop-count audit record; defaults to "local". */
  userId?: string;
  /**
   * R14 (2026-07-01 RAG backlog): opt-in near-duplicate suppression, applied AFTER the
   * post-rerank relevance floor but BEFORE the final slice-to-limit. A 0-1 Jaccard-shingle
   * similarity threshold — a candidate >= this similar to an already-kept chunk is dropped and
   * back-filled from later candidates. Omitted (undefined) = current behavior, no dedup pass.
   */
  dedupeSimilarity?: number;
  /**
   * persist-pool-v2 (2026-07-06): OPTIONAL per-candidate disposition capture hook. When supplied,
   * `rankPool` tracks every input candidate through each filtering stage (minScore -> asOf ->
   * rerank-truncate -> post-rerank floor -> dedupe) and invokes this callback exactly once with a
   * `Map` from a stable per-candidate key (the match's real Pinecone `id`, or a synthetic
   * `__cand_<inputIndex>__` key when the id is empty/missing — same id-less collision hardening
   * `retrieveContextDetailed`'s v1 capture already uses) to its `CandidateDisposition`. Every
   * candidate present in the original `matches` input gets exactly one entry; candidates that
   * survive every stage are recorded as `kept_not_used` here (the caller, which alone knows the
   * final top-`limit` slice, upgrades the ones actually used to `used`).
   *
   * Omitted (the default for every existing call site): zero extra work — no map allocation, no
   * key computation, no extra pass over the pool. `rankPool` remains a pure function with
   * byte-identical behavior/return value whether or not this option existed.
   */
  onDispositions?: (dispositions: Map<string, CandidateDisposition>) => void;
}

/**
 * Pure(ish) post-recall ranking pipeline: score floor → point-in-time guard (lenient or strict) →
 * optional hybrid BM25 fusion → optional cross-encoder rerank → post-rerank relevance floor.
 * Does NOT slice to `limit` or map to `RetrievedChunk` — callers do that themselves (this keeps
 * the helper reusable for both the real retrieval call site and network-free regression tests
 * that want to inspect the still-Pinecone-shaped `match[]` output, e.g. `_rerankScore`).
 *
 * Side effects (both fire-and-forget, never throw, never block the returned pool):
 *  - a `vector_asof_strict_drop` audit when strict as-of mode actually drops an undated chunk.
 *  - an R5 `recordRetrievalQuality()` distribution-telemetry record, ONLY when
 *    RAG_RETRIEVAL_TELEMETRY is on (a complete no-op — no hashing, no audit call — when off).
 */
export async function rankPool(
  matches: any[],
  query: string,
  limit: number,
  options: RankPoolOptions = {}
): Promise<any[]> {
  const candidates = matches.length;

  // persist-pool-v2 (2026-07-06): disposition tracking is entirely opt-in via `onDispositions`.
  // When absent (every existing call site), none of this block's code runs — `trackDrop`/
  // `keyFor` are never called, no Map is allocated — so `rankPool` is byte-identical in behavior
  // and cost to its pre-v2 form. Keys mirror the id-less collision hardening the v1 capture site
  // in `retrieveContextDetailed` already uses: a match's real Pinecone `id` when non-empty,
  // else a synthetic `__cand_<originalInputIndex>__` key scoped to the ORIGINAL `matches` array
  // position (stable across every filtering stage, unlike a re-computed post-filter index).
  const wantDispositions = typeof options.onDispositions === "function";
  const keyFor = (match: any, originalIndex: number): string =>
    typeof match?.id === "string" && match.id.length > 0 ? match.id : `__cand_${originalIndex}__`;
  // Two lookup tables, both built once up front (only when a hook is supplied): object identity
  // -> key, for matches that still carry their ORIGINAL object reference (true through minScore/
  // asOf filtering and `fuseHybrid`'s reordering, which reuses the same objects — see
  // `fuseHybrid`'s `idToMatch.get(id)` returning `matches[i]` directly, never a copy); and real-id
  // -> key, for post-rerank objects whose `id` field survives the copy.
  //
  // Review fix (2026-07-06): an id-less match that SURVIVES rerank is also returned as a NEW
  // spread object (`rerankMatches` copies `{ ...matches[idx], _rerankScore }` for every candidate
  // Voyage assigns a numeric relevanceScore to, real-id or not) — so the identity map alone is
  // NOT sufficient for id-less rerank survivors; they lose their original identity same as a
  // real-id match would, but have no `id` field for the real-id map to recover them by either.
  // `retrieveContextDetailed` (the only caller that ever supplies `onDispositions`) stamps a
  // stable own-enumerable `__poolKey` onto every id-less match in `matches` BEFORE calling
  // `rankPool` — a plain spread always copies own enumerable props, so `__poolKey` survives
  // rerank's copy intact. A third lookup table recovers those by that stamped key.
  const keyByIdentity = new Map<any, string>();
  const keyByRealId = new Map<string, string>();
  const keyByPoolKey = new Map<string, string>();
  if (wantDispositions) {
    matches.forEach((m, i) => {
      const key = keyFor(m, i);
      keyByIdentity.set(m, key);
      if (typeof m?.id === "string" && m.id.length > 0) keyByRealId.set(m.id, key);
      else if (typeof m?.__poolKey === "string" && m.__poolKey.length > 0) keyByPoolKey.set(m.__poolKey, key);
    });
  }
  const resolveKey = (match: any): string => {
    const byIdentity = keyByIdentity.get(match);
    if (byIdentity) return byIdentity;
    const byId = typeof match?.id === "string" && match.id.length > 0 ? keyByRealId.get(match.id) : undefined;
    if (byId) return byId;
    const byPoolKey = typeof match?.__poolKey === "string" && match.__poolKey.length > 0 ? keyByPoolKey.get(match.__poolKey) : undefined;
    if (byPoolKey) return byPoolKey;
    // Should be unreachable for any candidate that originated in `matches`, but fail safe rather
    // than throw: fall back to the id itself (still stable/unique in practice) if somehow neither
    // lookup hits.
    return String(match?.id ?? "");
  };
  const dispositions = wantDispositions ? new Map<string, CandidateDisposition>() : undefined;
  const trackDrop = (match: any, disposition: CandidateDisposition) => {
    if (!dispositions) return;
    dispositions.set(resolveKey(match), disposition);
  };

  let pool = matches;
  let droppedByMinScore = 0;
  if (options.minScore != null) {
    const before = pool.length;
    pool = pool.filter((match) => {
      const kept = (typeof match?.score === "number" ? match.score : 0) >= options.minScore!;
      if (!kept) trackDrop(match, "dropped_minscore");
      return kept;
    });
    droppedByMinScore = before - pool.length;
  }
  let droppedByAsOf = 0;
  if (options.asOf) {
    const strict = Boolean(options.strictAsOf);
    let droppedUndated = 0;
    const before = pool.length;
    pool = pool.filter((match) => {
      const md = match?.metadata as Record<string, unknown> | undefined;
      const kept = isWithinAsOf(md, options.asOf, strict);
      if (!kept) {
        if (strict && resolveAsOfStamp(md) == null) droppedUndated++;
        trackDrop(match, "dropped_asof");
      }
      return kept;
    });
    droppedByAsOf = before - pool.length;
    // R1 strict-mode drop-count (2026-07-01 expert-review follow-up): observability only, so the
    // ingest-dating gap ("how much of the corpus has no resolvable stamp") is visible to an
    // operator instead of silently shrinking results. Never throws; a logging failure must not
    // break retrieval.
    if (strict && droppedUndated > 0) {
      try {
        audit("vector_asof_strict_drop", { droppedUndated, asOf: options.asOf }, options.userId ?? "local");
      } catch {
        // best-effort telemetry only
      }
    }
  }
  // Hybrid BM25 fusion (flag-gated): reorder the candidate pool by RRF(dense, BM25) before
  // cross-encoder rerank. Falls back to dense order when off or on error. Does not change
  // overFetchK or the Pinecone query — purely a post-retrieval reordering step. Never drops.
  const fusedPool = options.hybrid && pool.length > 1 ? fuseHybrid(query, pool) : pool;
  const rerankRan = Boolean(options.rerank) && fusedPool.length > limit;
  const ordered = rerankRan ? await options.rerank!(query, fusedPool, limit) : fusedPool;
  if (wantDispositions && rerankRan) {
    // Voyage's rerank call is itself invoked with `topK: Math.min(limit, fusedPool.length)`
    // (see `rerankMatches`), so any candidate in `fusedPool` that did NOT come back in `ordered`
    // was truncated by that top-K cut, not by a relevance-floor comparison (the floor runs next,
    // against `ordered` only). Compare by `resolveKey` (not `===`) since `rerankMatches` returns
    // NEW spread objects for reordered items — see the identity/real-id lookup note above.
    const orderedKeys = new Set(ordered.map((m: any) => resolveKey(m)));
    for (const match of fusedPool) {
      if (!orderedKeys.has(resolveKey(match))) trackDrop(match, "dropped_rerank_truncate");
    }
  }
  // Post-rerank relevance floor (opt-in via minRelevanceScore), applied AFTER rerank but BEFORE the
  // final slice-to-limit — matches carrying no relevanceScore (rerank off/failed/didn't return one
  // for this item) are FAIL-OPEN kept, never treated as a 0: a transient Voyage 429 (which makes
  // rerankMatches fall back to cosine order with no scores) must not empty every result. The floor
  // can legitimately return fewer than `limit` chunks; callers (strategy.ts advisory context,
  // orchestrator.ts citations) already tolerate short lists. No-op unless set.
  const floored = options.minRelevanceScore != null
    ? ordered.filter((match) => {
        const s = (match as { _rerankScore?: unknown } | undefined)?._rerankScore;
        const kept = typeof s !== "number" || s >= options.minRelevanceScore!;
        if (!kept) trackDrop(match, "dropped_rerank_floor");
        return kept;
      })
    : ordered;

  // R14 (2026-07-01 RAG backlog): opt-in near-duplicate suppression, applied AFTER the
  // post-rerank relevance floor but BEFORE the final slice-to-limit (callers `.slice(0, limit)`
  // the RETURNED pool, so dedup must have already narrowed it here to have any effect). No-op
  // unless `dedupeSimilarity` is set.
  //
  // Disposition review fix (2026-07-06): `dedupeSimilar` drops candidates for TWO distinct
  // reasons — a genuine near-duplicate judgment, and its OWN internal top-`limit` cap (see the
  // `CandidateDisposition` doc comment in rag/candidate-pool.ts). Only ask for the (otherwise-free)
  // `report` out-param when a disposition hook is actually attached, so every existing caller pays
  // zero extra cost.
  const dedupeReport: DedupeSimilarReport | undefined = wantDispositions && options.dedupeSimilarity != null ? { genuineDuplicateIndices: [], neverReachedIndices: [] } : undefined;
  const deduped = options.dedupeSimilarity != null ? dedupeSimilar(floored, limit, options.dedupeSimilarity, dedupeReport) : floored;
  if (wantDispositions && options.dedupeSimilarity != null && dedupeReport) {
    for (const idx of dedupeReport.genuineDuplicateIndices) {
      trackDrop(floored[idx]!, "dropped_dedupe");
    }
    for (const idx of dedupeReport.neverReachedIndices) {
      trackDrop(floored[idx]!, "dropped_dedupe_truncate");
    }
  }

  if (dispositions) {
    // Everything still in `deduped` survived every rankPool-internal filter. `rankPool` itself
    // doesn't know the final top-`limit` slice (the caller applies that), so record every
    // survivor as `kept_not_used` here — the caller's `onDispositions` handler upgrades the ones
    // actually in its final slice to `used`.
    for (const match of deduped) {
      dispositions.set(resolveKey(match), "kept_not_used");
    }
    options.onDispositions!(dispositions);
  }

  // R5 consolidated retrieval-quality telemetry (2026-07-01 RAG backlog): default OFF via
  // RAG_RETRIEVAL_TELEMETRY. The flag check happens BEFORE any work (hashing, score scanning) so
  // this is a true no-op — not just a suppressed write — when the flag is unset.
  if (retrievalTelemetryEnabled()) {
    const topMatch = deduped[0] as { score?: unknown; _rerankScore?: unknown } | undefined;
    const topCosine = typeof topMatch?.score === "number" ? topMatch.score : undefined;
    const topRelevanceScore = typeof topMatch?._rerankScore === "number" ? topMatch._rerankScore : undefined;
    recordRetrievalQuality(
      {
        queryHash: hashQuery(query),
        k: limit,
        candidates,
        droppedByMinScore,
        droppedByAsOf,
        hybrid: Boolean(options.hybrid),
        rerankAttempted: Boolean(options.rerank),
        rerankRan,
        topCosine,
        topRelevanceScore,
        finalCount: deduped.length
      },
      options.userId ?? "local"
    );
  }

  return deduped;
}

/** Back-compat string[] view (used by strategy.ts) — thin wrapper over retrieveContextDetailed. */
export async function retrieveContext(
  query: string,
  symbol: string,
  limit: number = 3,
  userId: string = "local",
  options?: RetrieveOptions
): Promise<string[]> {
  const chunks = await retrieveContextDetailed(query, symbol, limit, userId, options);
  return chunks.map((c) => c.text).filter(Boolean);
}
