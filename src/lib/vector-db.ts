import { Pinecone, PineconeRecord, RecordMetadata } from '@pinecone-database/pinecone';
import { VoyageAIClient } from 'voyageai';
import { getUserApiKey } from './db';

// Using "voyage-finance-2" for high fidelity financial embeddings
const VOYAGE_MODEL = "voyage-finance-2";
const EMBEDDING_DIMENSION = 1024; // voyage-finance-2 dimension

/**
 * Ensures we have valid clients for Pinecone and Voyage.
 */
function getClients(userId: string = "local") {
  const pineconeKey = getUserApiKey(userId, "pinecone")?.apiKey || process.env.PINECONE_API_KEY;
  const voyageKey = getUserApiKey(userId, "voyage")?.apiKey || process.env.VOYAGE_API_KEY;

  if (!pineconeKey || !voyageKey) {
    return { pc: null, voyage: null };
  }

  const pc = new Pinecone({ apiKey: pineconeKey });
  const voyage = new VoyageAIClient({ apiKey: voyageKey });

  return { pc, voyage };
}

/**
 * Store a document context into Pinecone.
 */
export async function storeContext(
  text: string,
  metadata: { symbol: string; source: string; timestamp: string; [key: string]: any },
  userId: string = "local"
): Promise<void> {
  const { pc, voyage } = getClients(userId);
  if (!pc || !voyage) {
    console.log("[vector-db] Skipping storeContext: Missing Voyage or Pinecone keys.");
    return;
  }

  try {
    // Generate embedding using Voyage Finance model
    const response = await voyage.embed({
      model: VOYAGE_MODEL,
      input: [text],
    });

    const embedding = response.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error("Failed to generate Voyage embedding.");
    }

    const indexName = "robinhood-agentic"; // Default index name
    // Check if index exists or create it
    const indexes = await pc.listIndexes();
    if (!indexes.indexes || !indexes.indexes.some((i) => i.name === indexName)) {
      await pc.createIndex({
        name: indexName,
        dimension: EMBEDDING_DIMENSION,
        metric: 'cosine',
        spec: { serverless: { cloud: 'aws', region: 'us-east-1' } }
      });
      // wait a bit for it to be ready
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const index = pc.Index(indexName);
    const id = `${metadata.symbol}-${Date.now()}`;
    
    // Typecast to ensure RecordMetadata compliance
    const validMetadata: RecordMetadata = {
      ...metadata,
      text, // store the raw text
      userId,
    } as RecordMetadata;

    await index.upsert([
      {
        id,
        values: embedding,
        metadata: validMetadata
      }
    ] as any);

    console.log(`[vector-db] Successfully indexed context for ${metadata.symbol}`);
  } catch (err) {
    console.error("[vector-db] Error storing context:", err);
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
    });

    const embedding = response.data?.[0]?.embedding;
    if (!embedding) return [];

    const indexName = "robinhood-agentic";
    const indexes = await pc.listIndexes();
    if (!indexes.indexes || !indexes.indexes.some((i) => i.name === indexName)) {
      return [];
    }

    const index = pc.Index(indexName);
    const results = await index.query({
      vector: embedding,
      topK: limit,
      filter: {
        symbol: symbol,
        userId: userId,
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
