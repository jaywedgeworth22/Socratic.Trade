import { Pinecone, type PineconeRecord, type RecordMetadata } from "@pinecone-database/pinecone";
import { VoyageAIClient } from "voyageai";
import { audit, resolveApiKey, setInternalSetting } from "./db";
import { filterNewDocumentChunks, insertDocumentChunks } from "./db";
import { chunkDocument, type ChunkInput, type ChunkOptions } from "./rag/chunk";
import { fuseHybrid } from "./rag/hybrid";
import { meterEmbed, meterPineconeQuery, meterPineconeUpsert, meterRerank } from "./rag-metering";

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

function trimContextText(text: string): string {
  const trimmed = text.trim();
  const maxChars = contextMaxChars();
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

/**
 * Reorder Pinecone matches by Voyage cross-encoder relevance and keep the top `topK`. Pure
 * best-effort: on any error (rate limit, unsupported model, empty docs) returns the input order
 * unchanged so retrieval never breaks — reranking is a quality boost, not a dependency.
 */
export async function rerankMatches(voyage: VoyageAIClient, query: string, matches: any[], topK: number): Promise<any[]> {
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
    meterRerank(query, documents, rerankModel());
    const data = resp.data ?? [];
    if (data.length === 0) return matches;
    const reordered: any[] = [];
    for (const item of data) {
      const idx = item.index;
      if (typeof idx === "number" && matches[idx]) reordered.push(matches[idx]);
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

/**
 * Store multiple context documents in one embedding/upsert flow. This keeps Pinecone index
 * creation centralized and avoids one Voyage/Pinecone round-trip per SEC filing.
 */
export async function storeContexts(documents: ContextDocument[], userId: string = "local"): Promise<StoreContextsResult> {
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
      return { ...doc, text: trimContextText(text) };
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

    console.log(`[vector-db] Indexed ${indexed}/${validDocuments.length} context document(s).`);
    // Persist the outcome so RAG ingestion health is visible in the audit log / dashboard
    // instead of being swallowed to console (the original cause of the silent empty index).
    setInternalSetting(LAST_INGEST_KEY, { at: new Date().toISOString(), attempted: validDocuments.length, indexed });
    audit("vector_store", { ok: true, attempted: validDocuments.length, indexed }, userId);
    return { attempted: validDocuments.length, indexed };
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

  const result = await storeContexts(documents, userId);

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
 * Point-in-time guard for retrieval: returns false when a chunk's
 * acceptance_datetime / as_of / timestamp is strictly after `asOf` — a lookahead-bias guard for
 * backtest-style queries. Undated chunks and an unset/unparseable `asOf` are kept.
 */
export function isWithinAsOf(metadata: Record<string, unknown> | undefined, asOf: string | undefined): boolean {
  if (!asOf) return true;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return true;
  const stamp = metadata?.acceptance_datetime ?? metadata?.as_of ?? metadata?.timestamp;
  if (stamp == null) return true;
  const t = typeof stamp === "number" ? stamp : Date.parse(String(stamp));
  return !Number.isFinite(t) || t <= asOfMs;
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
}

/** Map a raw Pinecone match to a chunk carrying REAL provenance (id, score, acceptance date, url). */
export function matchToChunk(match: any): RetrievedChunk {
  const md = (match?.metadata ?? {}) as Record<string, unknown>;
  const asOf = md.acceptance_datetime ?? md.as_of ?? md.timestamp;
  const rawScope = md.scope;
  const scope: VectorScope | undefined =
    rawScope === SHARED_SCOPE || rawScope === PRIVATE_SCOPE ? rawScope : undefined;
  return {
    id: String(match?.id ?? ""),
    text: typeof md.text === "string" ? md.text : "",
    score: typeof match?.score === "number" ? match.score : 0,
    source: typeof md.source === "string" ? md.source : undefined,
    as_of: asOf != null ? String(asOf) : undefined,
    doc_type: typeof md.doc_type === "string" ? md.doc_type : undefined,
    section: typeof md.section === "string" ? md.section : undefined,
    url: typeof md.url === "string" ? md.url : typeof md.filingUrl === "string" ? md.filingUrl : undefined,
    scope
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
}

/** Build the optional metadata-filter clauses (doc_type/section/source) shared by both tiers. */
export function buildExtraFilters(options?: RetrieveOptions): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (options?.docType && options.docType.length > 0) {
    // doc_type casing is INCONSISTENT across ingesters — sec-filings.ts writes "10-K"/"10-Q" (upper) while
    // sec8k.ts writes "8-k" (lower) — and Pinecone `$in` is exact-match. Match every casing variant so a
    // filter never silently excludes a legitimately-stored doc type (which would be worse than no filter).
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
    const response = await embedWithRetry(voyage, [query], "query");
    meterEmbed([query]);

    const embedding = response.data?.[0]?.embedding;
    if (!embedding) return [];

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
      meterPineconeQuery(fetchK);
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
      meterPineconeQuery(fetchK * 2);

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

    // Pipeline: cosine recall → score floor → point-in-time guard → cross-encoder rerank → top-limit.
    let pool = matches;
    if (options?.minScore != null) {
      pool = pool.filter((match) => (typeof match?.score === "number" ? match.score : 0) >= options.minScore!);
    }
    if (options?.asOf) {
      pool = pool.filter((match) => isWithinAsOf(match.metadata as Record<string, unknown> | undefined, options.asOf));
    }
    // Hybrid BM25 fusion (flag-gated): reorder the candidate pool by RRF(dense, BM25) before
    // cross-encoder rerank. Falls back to dense order when off or on error. Does not change
    // overFetchK or the Pinecone query — purely a post-retrieval reranking step.
    const fusedPool = hybridRetrievalEnabled() && pool.length > 1
      ? fuseHybrid(query, pool)
      : pool;
    const ordered = wantRerank && fusedPool.length > limit
      ? await rerankMatches(voyage, query, fusedPool, limit)
      : fusedPool;
    return ordered
      .slice(0, limit)
      .map(matchToChunk)
      .filter((c) => c.text);
  } catch (err) {
    console.error("[vector-db] Error retrieving context:", err);
    return [];
  }
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
