import { Pinecone, type PineconeRecord, type RecordMetadata } from "@pinecone-database/pinecone";
import { VoyageAIClient } from "voyageai";
import { audit, resolveApiKey, setInternalSetting } from "./db";
import { filterNewDocumentChunks, insertDocumentChunks } from "./db";
import { CHARS_PER_TOKEN_CEILING, DEFAULT_MAX_TOKENS, chunkDocument, type ChunkInput, type ChunkOptions } from "./rag/chunk";
import { fuseHybrid } from "./rag/hybrid";
import { meterEmbed, meterPineconeQuery, meterPineconeUpsert, meterRerank } from "./rag-metering";
import { isOverLlmBudget } from "./llm-budget";

const LAST_INGEST_KEY = "vectorStore:lastIngest";

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
  /** True when Pinecone/Voyage keys were missing, so nothing could be stored. */
  skipped?: boolean;
  /**
   * Count of embeddings dropped by the integrity guard (R2: wrong dimension or non-finite values,
   * e.g. a Voyage model/config drift) instead of being upserted as a degenerate vector. 0 in the
   * healthy case; always present so callers can tell "nothing to embed" from "embed came back bad".
   */
  rejectedInvalidEmbeddings?: number;
}

export interface VectorStoreStats {
  configured: boolean;
  indexName: string;
  exists?: boolean;
  totalVectorCount?: number;
  dimension?: number;
  error?: string;
}

// Using "voyage-finance-2" for high fidelity financial embeddings
const VOYAGE_MODEL = "voyage-finance-2";
const EMBEDDING_DIMENSION = 1024; // voyage-finance-2 dimension
const DEFAULT_INDEX_NAME = "robinhood-agentic";
const DEFAULT_EMBED_BATCH_SIZE = 8;
const DEFAULT_EMBED_BATCH_DELAY_MS = 21_000; // unpaid Voyage limit is 3 RPM; paid accounts can set this to 0.
const DEFAULT_CONTEXT_MAX_CHARS = 2400;
const DEFAULT_EMBED_RETRY_ATTEMPTS = 2;
const DEFAULT_EMBED_RETRY_DELAY_MS = 20_000;

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

export interface ContextDocument {
  text: string;
  metadata: { symbol: string; source: string; timestamp: string; accession?: string; [key: string]: unknown };
}

const indexInitPromises = new Map<string, Promise<void>>();

function indexName(): string {
  return process.env.PINECONE_INDEX_NAME || DEFAULT_INDEX_NAME;
}

function indexReadyWaitMs(): number {
  const parsed = Number(process.env.PINECONE_INDEX_READY_WAIT_MS ?? 5000);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

function numericEnv(name: string, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Cosine-similarity floor applied at every retrieval call site unless the caller overrides it.
 *  Set VECTOR_MIN_SCORE=0 to disable the floor (restores the previous no-floor behavior). Default 0.30. */
export function defaultMinScore(): number {
  return numericEnv("VECTOR_MIN_SCORE", 0.3, 0, 1);
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
  const v = String(process.env.VECTOR_ENABLE_RERANK ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}
function rerankModel(): string {
  return process.env.VOYAGE_RERANK_MODEL || DEFAULT_RERANK_MODEL;
}
/** How many candidates to pull from Pinecone before reranking/as-of filtering down to `limit`. */
function overFetchK(limit: number): number {
  return Math.min(Math.max(limit * 5, limit), 50);
}

/** Hybrid dense+BM25 retrieval via Reciprocal Rank Fusion. OFF by default — set HYBRID_RETRIEVAL=on to enable.
 *  When OFF, the retrieval path is byte-for-byte the current dense-only flow. */
function hybridRetrievalEnabled(): boolean {
  const v = String(process.env.HYBRID_RETRIEVAL ?? "false").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(v);
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
  const v = String(process.env.VECTOR_ASOF_STRICT ?? "false").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(v);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
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

function getClients(userId: string = "local") {
  const lookupUserId = userId || "local";
  const pineconeKey = resolveApiKey("pinecone", lookupUserId);
  const voyageKey = resolveApiKey("voyage", lookupUserId);

  if (!pineconeKey || !voyageKey) {
    return { pc: null, voyage: null, initCacheKey: "" };
  }

  const cacheKey = `${pineconeKey}|${voyageKey}`;
  let clients = clientCache.get(cacheKey);
  if (!clients) {
    clients = { pc: new Pinecone({ apiKey: pineconeKey }), voyage: new VoyageAIClient({ apiKey: voyageKey }) };
    clientCache.set(cacheKey, clients);
  }

  return { pc: clients.pc, voyage: clients.voyage, initCacheKey: `${pineconeKey}:${indexName()}` };
}

async function ensureIndex(pc: Pinecone, initCacheKey: string): Promise<void> {
  const cached = indexInitPromises.get(initCacheKey);
  if (cached) return cached;

  const init = (async () => {
    const name = indexName();
    const indexes = await pc.listIndexes();
    if (!indexes.indexes?.some((i) => i.name === name)) {
      try {
        await pc.createIndex({
          name,
          dimension: EMBEDDING_DIMENSION,
          metric: "cosine",
          spec: { serverless: { cloud: "aws", region: "us-east-1" } }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists|409|conflict/i.test(message)) throw error;
      }
      await sleep(indexReadyWaitMs());
    }
  })();

  indexInitPromises.set(initCacheKey, init);
  try {
    await init;
  } catch (error) {
    indexInitPromises.delete(initCacheKey);
    throw error;
  }
}

async function indexExists(pc: Pinecone): Promise<boolean> {
  const indexes = await pc.listIndexes();
  return Boolean(indexes.indexes?.some((i) => i.name === indexName()));
}

function cleanMetadata(metadata: ContextDocument["metadata"], text: string, userId: string): RecordMetadata {
  // Derive scope from the userId sentinel used to signal the shared/public tier.
  // New vectors carry an explicit `scope` field; legacy vectors written before this change
  // do NOT have it (backward-compat: they are still matched via the userId filter).
  const scope: VectorScope = userId === "local" ? SHARED_SCOPE : PRIVATE_SCOPE;
  const out: Record<string, string | number | boolean | string[]> = { text, userId, scope };
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "text" || key === "userId" || key === "scope") continue;
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
  return out as RecordMetadata;
}

function vectorUserIdFor(userId: string | undefined): string {
  return sanitizeUserId(userId);
}

function contextId(document: ContextDocument, fallbackIndex: number): string {
  const { symbol, source, accession, timestamp } = document.metadata;
  const raw = [source, symbol, accession, timestamp].filter(Boolean).join(":") || `${symbol}:${source}:${fallbackIndex}`;
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 512);
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
  inputType: "document" | "query"
): Promise<Awaited<ReturnType<VoyageAIClient["embed"]>>> {
  const attempts = embedRetryAttempts();
  for (let attempt = 0; ; attempt++) {
    try {
      return await voyage.embed({
        model: VOYAGE_MODEL,
        input,
        inputType
      });
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= attempts) throw error;
      const delay = retryAfterMs(error, attempt);
      console.warn(`[vector-db] Voyage rate limited for inputType=${inputType}; retrying in ${Math.round(delay / 1000)}s.`);
      await sleep(delay);
    }
  }
}

async function embedDocumentsWithRetry(
  voyage: VoyageAIClient,
  input: string[]
): Promise<Awaited<ReturnType<VoyageAIClient["embed"]>>> {
  return embedWithRetry(voyage, input, "document");
}

// ── Query-embedding LRU cache (G8b) ────────────────────────────────────────
// Small in-process cache for the single-query embed call in retrieveContextDetailed. Document/
// upsert embeddings are NEVER cached (only the "query" inputType path below uses this). Keyed by
// normalized query text so trivial whitespace/casing variants of the same question share a hit.
// Bounded LRU (default 128 entries) — a Map preserves insertion order, so "touch on hit" is done by
// delete+re-set, and eviction just deletes the oldest (first) key once over the bound.
type EmbedResponse = Awaited<ReturnType<VoyageAIClient["embed"]>>;

const DEFAULT_QUERY_EMBED_CACHE_SIZE = 128;

function queryEmbedCacheSize(): number {
  return Math.floor(numericEnv("VECTOR_QUERY_EMBED_CACHE_SIZE", DEFAULT_QUERY_EMBED_CACHE_SIZE, 0, 10_000));
}

function queryEmbedCacheEnabled(): boolean {
  const v = String(process.env.VECTOR_QUERY_EMBED_CACHE ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v) && queryEmbedCacheSize() > 0;
}

/** Normalize query text so "AAPL guidance", " aapl  guidance ", "AAPL GUIDANCE" share a cache entry. */
export function normalizeQueryCacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

// One LRU per underlying Voyage client instance so cached embeddings never leak across distinct
// API keys/tenants (getClients() already memoizes clients per key-pair, so this keys naturally).
// Map (not WeakMap) so tests can enumerate/clear it deterministically between runs.
const queryEmbedCaches = new Map<VoyageAIClient, Map<string, EmbedResponse>>();

function cacheFor(voyage: VoyageAIClient): Map<string, EmbedResponse> {
  let cache = queryEmbedCaches.get(voyage);
  if (!cache) {
    cache = new Map();
    queryEmbedCaches.set(voyage, cache);
  }
  return cache;
}

/** Test-only: drop all cached query embeddings (all clients). */
export function clearQueryEmbedCache(): void {
  queryEmbedCaches.clear();
}

/**
 * Embed a single retrieval QUERY, served from a bounded per-client LRU cache when enabled
 * (default on, 128 entries — set VECTOR_QUERY_EMBED_CACHE=off or VECTOR_QUERY_EMBED_CACHE_SIZE=0 to
 * disable). Only ever called with inputType "query" — document/upsert embeddings always go through
 * embedDocumentsWithRetry uncached.
 *
 * Returns `cached` so the caller can skip usage metering on a hit — a cache hit made NO Voyage
 * request, so metering it would insert phantom rag_usage rows + estimated cost and corrupt the
 * cost dashboards the cache is meant to shrink.
 */
async function embedQueryCached(
  voyage: VoyageAIClient,
  query: string
): Promise<{ response: EmbedResponse; cached: boolean }> {
  if (!queryEmbedCacheEnabled()) return { response: await embedWithRetry(voyage, [query], "query"), cached: false };

  const cache = cacheFor(voyage);
  const key = normalizeQueryCacheKey(query);
  const hit = cache.get(key);
  if (hit) {
    // Touch: move to most-recently-used position.
    cache.delete(key);
    cache.set(key, hit);
    return { response: hit, cached: true };
  }

  const response = await embedWithRetry(voyage, [query], "query");
  cache.set(key, response);
  const maxSize = queryEmbedCacheSize();
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return { response, cached: false };
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
export async function rerankMatches(voyage: VoyageAIClient, query: string, matches: any[], topK: number, userId?: string): Promise<any[]> {
  if (matches.length <= 1) return matches;
  const documents = matches.map((m) => {
    const t = (m?.metadata as Record<string, unknown> | undefined)?.text;
    return typeof t === "string" ? t : "";
  });
  if (documents.every((d) => !d)) return matches;
  try {
    const resp = await voyage.rerank({
      query,
      documents,
      model: rerankModel(),
      topK: Math.min(topK, matches.length),
      truncation: true
    });
    meterRerank(query, documents, rerankModel(), userId);
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
  await storeContexts([{ text, metadata }], userId);
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
      return { ...doc, text: isTable ? text.trim() : trimContextText(text, options?.maxChars) };
    })
    .filter((doc) => doc.text.length > 0);
  if (validDocuments.length === 0) return { attempted: 0, indexed: 0 };

  const { pc, voyage, initCacheKey } = getClients(userId);
  if (!pc || !voyage) {
    console.log("[vector-db] Skipping storeContexts: Missing Voyage or Pinecone keys.");
    audit("vector_store", { ok: false, attempted: validDocuments.length, indexed: 0, skipped: true, reason: "missing Pinecone/Voyage keys" }, userId);
    return { attempted: validDocuments.length, indexed: 0, skipped: true };
  }

  let indexed = 0;
  let rejectedInvalidEmbeddings = 0;
  try {
    await ensureIndex(pc, initCacheKey);
    const index = pc.Index(indexName());
    const batches = chunks(validDocuments, embedBatchSize());

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      if (!batch) continue;
      if (batchIndex > 0) await sleep(embedBatchDelayMs());
      const response = await embedDocumentsWithRetry(voyage, batch.map((doc) => doc.text));
      meterEmbed(batch.map((doc) => doc.text));

      const records: PineconeRecord<RecordMetadata>[] = [];
      response.data?.forEach((item, indexInBatch) => {
        const embedding = item.embedding;
        const document = batch[indexInBatch];
        if (!embedding || !document) return;
        // R2 integrity guard: reject (don't upsert) a malformed embedding — wrong dimension or a
        // non-finite value (e.g. a Voyage model/config drift, partial/NaN response) would otherwise
        // silently poison cosine scoring for every future query against this vector. Drop + count;
        // never throw — one bad vector in a batch must not fail the whole batch.
        if (!isValidEmbedding(embedding)) {
          rejectedInvalidEmbeddings++;
          const dim = Array.isArray(embedding as unknown) ? (embedding as unknown[]).length : "n/a";
          console.warn(`[vector-db] Rejected malformed embedding (dim=${dim}) for doc "${contextId(document, indexInBatch)}" — not upserted.`);
          return;
        }
        records.push({
          id: contextId(document, indexInBatch),
          values: embedding,
          metadata: cleanMetadata(document.metadata, document.text, vectorUserId)
        });
      });

      if (records.length > 0) {
        // Pinecone JS SDK v8 takes an options object ({ records }), not a bare array.
        await index.upsert({ records } as any);
        indexed += records.length;
        meterPineconeUpsert(records.length);
      }
    }

    if (rejectedInvalidEmbeddings > 0) {
      audit("vector_embedding_integrity", { rejected: rejectedInvalidEmbeddings, attempted: validDocuments.length }, userId);
    }
    console.log(`[vector-db] Indexed ${indexed}/${validDocuments.length} context document(s).${rejectedInvalidEmbeddings > 0 ? ` (${rejectedInvalidEmbeddings} rejected: malformed embedding)` : ""}`);
    // Persist the outcome so RAG ingestion health is visible in the audit log / dashboard
    // instead of being swallowed to console (the original cause of the silent empty index).
    setInternalSetting(LAST_INGEST_KEY, { at: new Date().toISOString(), attempted: validDocuments.length, indexed });
    audit("vector_store", { ok: true, attempted: validDocuments.length, indexed, rejectedInvalidEmbeddings }, userId);
    return { attempted: validDocuments.length, indexed, ...(rejectedInvalidEmbeddings > 0 ? { rejectedInvalidEmbeddings } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[vector-db] Error storing contexts:", err);
    setInternalSetting(LAST_INGEST_KEY, { at: new Date().toISOString(), attempted: validDocuments.length, indexed, error });
    audit("vector_store", { ok: false, attempted: validDocuments.length, indexed, error }, userId);
    return { attempted: validDocuments.length, indexed, error };
  }
}

/**
 * Chunk a long document (structure-aware) and store each chunk as its own vector, carrying
 * `acceptance_datetime` so retrieval can apply a point-in-time (`as_of`) filter. Prefer this over
 * storeContexts for anything longer than a short catalyst summary (e.g. full 10-K risk sections).
 */
export async function storeDocument(
  doc: ChunkInput & { symbol?: string },
  userId: string = "local",
  options?: ChunkOptions
): Promise<StoreContextsResult> {
  const chunked = chunkDocument(doc, options);
  const fallbackSymbol = doc.symbol ?? (Array.isArray(doc.ticker) ? doc.ticker[0] : doc.ticker) ?? "";
  const source = doc.source || "sec-edgar";

  // Dedup by content_hash: skip chunks whose text byte sequence has already been embedded.
  // The document_chunks table is keyed on content_hash (SHA-256, first 16 hex chars) so a
  // re-run of the same filing text never pays Voyage tokens for unchanged chunks.
  const chunkHashes = chunked.map((c) => ({
    content_hash: c.content_hash,
    symbol: c.ticker[0] ?? fallbackSymbol,
    source,
    chunk_id: c.chunk_id
  }));
  const newHashes = filterNewDocumentChunks(chunkHashes);
  const newHashSet = new Set(newHashes.map((h) => h.content_hash));
  const freshChunks = chunked.filter((c) => newHashSet.has(c.content_hash));

  if (freshChunks.length < chunked.length) {
    console.log(
      `[vector-db] Content-hash dedup: ${chunked.length - freshChunks.length}/${chunked.length} chunks already indexed, skipping.`
    );
  }
  if (freshChunks.length === 0) {
    return { attempted: chunked.length, indexed: 0, skipped: true };
  }

  const documents: ContextDocument[] = freshChunks.map((c) => ({
    text: `${c.context_header}\n\n${c.text}`,
    metadata: {
      symbol: c.ticker[0] ?? fallbackSymbol,
      source: c.source,
      timestamp: c.published_at,
      accession: c.chunk_id,
      acceptance_datetime: c.acceptance_datetime,
      section: c.section,
      doc_type: c.doc_type,
      is_table: c.is_table,
      ticker: c.ticker,
      content_hash: c.content_hash,
      ...(doc.url ? { url: doc.url } : {})
    }
  }));

  // Align the storeContexts trim cap with the ACTUAL token budget chunkDocument used (plus the
  // context_header prefix), rather than the fixed 2400-char default — otherwise a structure-aware
  // chunk that chunkDocument deliberately kept atomic (e.g. a table) can be silently truncated a
  // second time downstream. Generous chars-per-token ceiling covers long words/table padding.
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const headerAllowance = 512; // context_header is short, deterministic prose — generous fixed budget
  const chunkAlignedMaxChars = Math.max(contextMaxChars(), maxTokens * CHARS_PER_TOKEN_CEILING + headerAllowance);

  const result = await storeContexts(documents, userId, { maxChars: chunkAlignedMaxChars });

  // Record fresh chunks in document_chunks so the dedup gate works on subsequent runs.
  // Do this even on partial success — the table is INSERT OR IGNORE so double-writes are harmless,
  // and failing to record a chunk means it gets re-embedded next time.
  if (result.indexed > 0) {
    const indexedHashes = freshChunks.slice(0, result.indexed).map((c) => ({
      content_hash: c.content_hash,
      symbol: c.ticker[0] ?? fallbackSymbol,
      source: c.source,
      chunk_id: c.chunk_id
    }));
    try {
      insertDocumentChunks(indexedHashes);
    } catch (err) {
      console.warn("[vector-db] insertDocumentChunks failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
  }

  // Restore the full attempted count so callers see the truth about how many chunks exist.
  return { ...result, attempted: chunked.length };
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

/**
 * Live Pinecone index stats — used by the reindex/diagnostic route so the operator can
 * confirm `totalVectorCount > 0` after a backfill instead of guessing.
 */
export async function getVectorStoreStats(userId: string = "local"): Promise<VectorStoreStats> {
  const name = indexName();
  const { pc } = getClients(userId);
  if (!pc) return { configured: false, indexName: name };
  try {
    if (!(await indexExists(pc))) return { configured: true, indexName: name, exists: false };
    const stats = (await pc.Index(name).describeIndexStats()) as {
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
}

/** Map a raw Pinecone match to a chunk carrying REAL provenance (id, score, acceptance date, url). */
export function matchToChunk(match: any): RetrievedChunk {
  const md = (match?.metadata ?? {}) as Record<string, unknown>;
  const asOf = md.acceptance_datetime ?? md.as_of ?? md.timestamp;
  const rawScope = md.scope;
  const scope: VectorScope | undefined =
    rawScope === SHARED_SCOPE || rawScope === PRIVATE_SCOPE ? rawScope : undefined;
  const rerankScore = (match as { _rerankScore?: unknown } | undefined)?._rerankScore;
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
    ...(typeof rerankScore === "number" ? { relevanceScore: rerankScore } : {})
  };
}

/**
 * Retrieve relevant chunks from Pinecone with REAL provenance (id/score/as_of/url) so answers can
 * be grounded and honestly cited.
 */
export interface RetrieveOptions {
  /** Point-in-time guard: drop chunks whose acceptance_datetime is after this ISO date. */
  asOf?: string;
  /** Restrict to these document types (metadata.doc_type), e.g. ["10-k","10-q"]. */
  docType?: string[];
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
export function buildExtraFilters(options?: RetrieveOptions): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (options?.docType && options.docType.length > 0) {
    const variants = Array.from(new Set(options.docType.flatMap((d) => [d, d.toLowerCase(), d.toUpperCase()])));
    extra.doc_type = { $in: variants };
  }
  if (options?.section) extra.section = { $eq: options.section };
  if (options?.source) extra.source = { $eq: options.source };
  return extra;
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
  if (isOverLlmBudget(userId)) return [];
  const vectorUserId = vectorUserIdFor(userId);
  const { pc, voyage } = getClients(userId);
  if (!pc || !voyage) return [];
  const wantRerank = rerankEnabled();
  // Over-fetch when we'll post-filter (as-of), rerank, OR hybrid-fuse — so the final top-`limit` is
  // high quality. Hybrid must be included even when rerank is off: otherwise fetchK == limit and the
  // BM25/RRF step only reorders the dense top-N, so an exact ticker/accession hit at dense rank
  // limit+1 is never in the pool and the recall gap the flag targets can't be recovered.
  const fetchK = options?.asOf || wantRerank || hybridRetrievalEnabled() ? overFetchK(limit) : limit;
  const extraFilter = buildExtraFilters(options);

  try {
    const { response, cached } = await embedQueryCached(voyage, query);
    // Only meter a real Voyage embed request — a cache hit made no call, so metering it would
    // record phantom usage/cost and defeat the point of the cache. Book it under the REQUESTING
    // userId so this retrieval spend counts toward that user's daily LLM/RAG budget (not "local").
    if (!cached) meterEmbed([query], undefined, userId);

    const embedding = response.data?.[0]?.embedding;
    // R2 integrity guard applies to the query embedding too: a malformed vector (wrong dimension,
    // NaN) would return garbage matches rather than a clean empty result. Audit so a Voyage
    // model/config drift is observable instead of silently returning bad matches.
    if (!isValidEmbedding(embedding)) {
      if (embedding != null) {
        const dim = Array.isArray(embedding as unknown) ? (embedding as unknown[]).length : "n/a";
        audit("vector_embedding_integrity", { rejected: 1, context: "query" }, userId);
        console.warn(`[vector-db] Rejected malformed query embedding (dim=${dim}).`);
      }
      return [];
    }

    if (!(await indexExists(pc))) return [];

    const index = pc.Index(indexName());

    let matches: any[] = [];

    // The shared-tier filter uses $or to match BOTH new vectors (scope=='shared') and legacy
    // pre-scope vectors (userId=='local'). This is the backward-compat coexistence strategy:
    // scope is authoritative for new vectors; userId is the fallback for old ones.
    const sharedTierFilter = {
      symbol: { $eq: symbol },
      ...extraFilter,
      $or: [
        { scope: { $eq: SHARED_SCOPE } },
        { userId: { $eq: "local" } }
      ]
    };

    if (vectorUserId === "local") {
      const results = await index.query({
        vector: embedding,
        topK: fetchK,
        filter: sharedTierFilter,
        includeMetadata: true,
      });
      matches = results.matches || [];
      meterPineconeQuery(fetchK, userId);
    } else {
      const [userResults, localResults] = await Promise.all([
        index.query({
          vector: embedding,
          topK: fetchK,
          filter: {
            symbol: { $eq: symbol },
            userId: { $eq: vectorUserId },
            ...extraFilter
          },
          includeMetadata: true,
        }),
        index.query({
          vector: embedding,
          topK: fetchK,
          filter: sharedTierFilter,
          includeMetadata: true,
        })
      ]);
      meterPineconeQuery(fetchK * 2, userId);

      const combined = [...(userResults.matches || []), ...(localResults.matches || [])];
      combined.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      const seenIds = new Set<string>();
      const unique = [];
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
      matches = unique.slice(0, fetchK);
    }

    // Pipeline: cosine recall → score floor → point-in-time guard → hybrid fuse → cross-encoder
    // rerank → post-rerank floor → top-limit. Factored into the pure `rankPool` helper (R4,
    // 2026-07-01 expert-review follow-up) so a network-free regression test can drive the exact
    // same post-recall logic this call site uses, instead of re-implementing it in test code.
    const ordered = await rankPool(matches, query, limit, {
      minScore: options?.minScore,
      asOf: options?.asOf,
      minRelevanceScore: options?.minRelevanceScore,
      hybrid: hybridRetrievalEnabled(),
      rerank: wantRerank ? (q, m, k) => rerankMatches(voyage, q, m, k, userId) : undefined,
      strictAsOf: asOfStrictEnabled(),
      userId
    });
    return ordered
      .slice(0, limit)
      .map(matchToChunk)
      .filter((c) => c.text);
  } catch (err) {
    console.error("[vector-db] Error retrieving context:", err);
    return [];
  }
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
}

/**
 * Pure(ish) post-recall ranking pipeline: score floor → point-in-time guard (lenient or strict) →
 * optional hybrid BM25 fusion → optional cross-encoder rerank → post-rerank relevance floor.
 * Does NOT slice to `limit` or map to `RetrievedChunk` — callers do that themselves (this keeps
 * the helper reusable for both the real retrieval call site and network-free regression tests
 * that want to inspect the still-Pinecone-shaped `match[]` output, e.g. `_rerankScore`).
 *
 * The only side effect is a fire-and-forget `audit()` call when strict as-of mode actually drops
 * an undated chunk — never throws, never blocks the returned pool.
 */
export async function rankPool(
  matches: any[],
  query: string,
  limit: number,
  options: RankPoolOptions = {}
): Promise<any[]> {
  let pool = matches;
  if (options.minScore != null) {
    pool = pool.filter((match) => (typeof match?.score === "number" ? match.score : 0) >= options.minScore!);
  }
  if (options.asOf) {
    const strict = Boolean(options.strictAsOf);
    let droppedUndated = 0;
    pool = pool.filter((match) => {
      const md = match?.metadata as Record<string, unknown> | undefined;
      const kept = isWithinAsOf(md, options.asOf, strict);
      if (!kept && strict && resolveAsOfStamp(md) == null) droppedUndated++;
      return kept;
    });
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
  // overFetchK or the Pinecone query — purely a post-retrieval reordering step.
  const fusedPool = options.hybrid && pool.length > 1 ? fuseHybrid(query, pool) : pool;
  const ordered = options.rerank && fusedPool.length > limit ? await options.rerank(query, fusedPool, limit) : fusedPool;
  // Post-rerank relevance floor (opt-in via minRelevanceScore), applied AFTER rerank but BEFORE the
  // final slice-to-limit — matches carrying no relevanceScore (rerank off/failed/didn't return one
  // for this item) are FAIL-OPEN kept, never treated as a 0: a transient Voyage 429 (which makes
  // rerankMatches fall back to cosine order with no scores) must not empty every result. The floor
  // can legitimately return fewer than `limit` chunks; callers (strategy.ts advisory context,
  // orchestrator.ts citations) already tolerate short lists. No-op unless set.
  const floored = options.minRelevanceScore != null
    ? ordered.filter((match) => {
        const s = (match as { _rerankScore?: unknown } | undefined)?._rerankScore;
        return typeof s !== "number" || s >= options.minRelevanceScore!;
      })
    : ordered;
  return floored;
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
