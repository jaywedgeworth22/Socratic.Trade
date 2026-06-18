import { Pinecone, type PineconeRecord, type RecordMetadata } from "@pinecone-database/pinecone";
import { VoyageAIClient } from "voyageai";
import { getUserApiKey } from "./db";

// Using "voyage-finance-2" for high fidelity financial embeddings
const VOYAGE_MODEL = "voyage-finance-2";
const EMBEDDING_DIMENSION = 1024; // voyage-finance-2 dimension
const DEFAULT_INDEX_NAME = "robinhood-agentic";
const MAX_EMBED_BATCH = 96; // Voyage supports up to 128 inputs; leave headroom for long filings.

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

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Ensures we have valid clients for Pinecone and Voyage.
 */
function getClients(userId: string = "local") {
  const pineconeKey = getUserApiKey(userId, "pinecone")?.apiKey || process.env.PINECONE_API_KEY;
  const voyageKey = getUserApiKey(userId, "voyage")?.apiKey || process.env.VOYAGE_API_KEY;

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
export async function storeContexts(documents: ContextDocument[], userId: string = "local"): Promise<void> {
  const validDocuments = documents.filter((doc) => doc.text.trim().length > 0);
  if (validDocuments.length === 0) return;

  const { pc, voyage, initCacheKey } = getClients(userId);
  if (!pc || !voyage) {
    console.log("[vector-db] Skipping storeContexts: Missing Voyage or Pinecone keys.");
    return;
  }

  try {
    await ensureIndex(pc, initCacheKey);
    const index = pc.Index(indexName());

    for (const batch of chunks(validDocuments, MAX_EMBED_BATCH)) {
      const response = await voyage.embed({
        model: VOYAGE_MODEL,
        input: batch.map((doc) => doc.text),
        inputType: "document"
      });

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

      if (records.length > 0) await index.upsert(records as any);
    }

    console.log(`[vector-db] Indexed ${validDocuments.length} context document(s).`);
  } catch (err) {
    console.error("[vector-db] Error storing contexts:", err);
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
