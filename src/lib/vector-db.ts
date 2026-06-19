import { Pinecone, type PineconeRecord, type RecordMetadata } from "@pinecone-database/pinecone";
import { VoyageAIClient } from "voyageai";
import { audit, resolveApiKey, setInternalSetting } from "./db";

const LAST_INGEST_KEY = "vectorStore:lastIngest";

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

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Ensures we have valid clients for Pinecone and Voyage.
 */
function getClients(userId: string = "local") {
  const pineconeKey = resolveApiKey("pinecone", userId);
  const voyageKey = resolveApiKey("voyage", userId);

  if (!pineconeKey || !voyageKey) {
    return { pc: null, voyage: null, initCacheKey: "" };
  }

  const pc = new Pinecone({ apiKey: pineconeKey });
  const voyage = new VoyageAIClient({ apiKey: voyageKey });

  return { pc, voyage, initCacheKey: `${pineconeKey}:${indexName()}` };
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
  const out: Record<string, string | number | boolean | string[]> = { text, userId };
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(String).filter(Boolean);
  }
  return out as RecordMetadata;
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

function retryAfterMs(error: unknown, attempt: number): number {
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
  return Math.max(embedBatchDelayMs(), Math.min(60_000, embedRetryDelayMs() * (attempt + 1)));
}

async function embedDocumentsWithRetry(
  voyage: VoyageAIClient,
  input: string[]
): Promise<Awaited<ReturnType<VoyageAIClient["embed"]>>> {
  const attempts = embedRetryAttempts();
  for (let attempt = 0; ; attempt++) {
    try {
      return await voyage.embed({
        model: VOYAGE_MODEL,
        input,
        inputType: "document"
      });
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= attempts) throw error;
      const delay = retryAfterMs(error, attempt);
      console.warn(`[vector-db] Voyage rate limited; retrying batch in ${Math.round(delay / 1000)}s.`);
      await sleep(delay);
    }
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
  const validDocuments = documents
    .map((doc) => ({ ...doc, text: trimContextText(doc.text) }))
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

      const records: PineconeRecord<RecordMetadata>[] = [];
      response.data?.forEach((item, indexInBatch) => {
        const embedding = item.embedding;
        const document = batch[indexInBatch];
        if (!embedding || !document) return;
        records.push({
          id: contextId(document, indexInBatch),
          values: embedding,
          metadata: cleanMetadata(document.metadata, document.text, userId)
        });
      });

      if (records.length > 0) {
        // Pinecone JS SDK v8 takes an options object ({ records }), not a bare array.
        await index.upsert({ records } as any);
        indexed += records.length;
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

/**
 * Retrieve relevant documents from Pinecone for a given query and symbol.
 */
export async function retrieveContext(
  query: string,
  symbol: string,
  limit: number = 3,
  userId: string = "local"
): Promise<string[]> {
  const { pc, voyage } = getClients(userId);
  if (!pc || !voyage) return [];

  try {
    const response = await voyage.embed({
      model: VOYAGE_MODEL,
      input: [query],
      inputType: "query"
    });

    const embedding = response.data?.[0]?.embedding;
    if (!embedding) return [];

    if (!(await indexExists(pc))) return [];

    const index = pc.Index(indexName());
    const results = await index.query({
      vector: embedding,
      topK: limit,
      filter: {
        symbol,
        userId
      },
      includeMetadata: true,
    });

    return results.matches
      .map(match => match.metadata?.text as string)
      .filter(Boolean);
  } catch (err) {
    console.error("[vector-db] Error retrieving context:", err);
    return [];
  }
}
