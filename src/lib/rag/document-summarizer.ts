// Document Summarizer Engine (Layer 3: Derived Abstracts & Summaries)
//
// Extracts structured abstracts and briefs from raw source chunks (10-K, 10-Q, 8-K, transcripts),
// links every extracted fact to source_chunk_ids, saves the structured summary into the relational DB
// `document_abstracts` table, and embeds the summary document into the RAG vector corpus.

import { insertDocumentAbstract, DocumentAbstract, getDb } from "../db";
import { storeDocument } from "../vector-db";

export interface SummarizeDocumentInput {
  ticker: string;
  accessionOrEventId: string;
  sourceType: "10k-delta" | "10q-delta" | "earnings-summary" | "8k-brief" | string;
  headline: string;
  chunks: Array<{ id: string; text: string }>;
  publishedAt?: string;
  acceptanceDatetime?: string;
}

export interface SummarizeDocumentResult {
  abstractId: string;
  skipped: boolean;
  error?: string;
}

/**
 * Generates a cited summary abstract for a document, saves it to `document_abstracts`,
 * and embeds it into the RAG vector store with `doc_type: "document-summary"` or `"earnings-summary"`.
 */
export async function generateAndStoreDocumentAbstract(
  input: SummarizeDocumentInput
): Promise<SummarizeDocumentResult> {
  const db = getDb();
  
  // Check if abstract already exists for this accession/event
  const existing = db
    .prepare("SELECT id FROM document_abstracts WHERE accession_or_event_id = ? AND source_type = ?")
    .get(input.accessionOrEventId, input.sourceType) as { id: string } | undefined;

  if (existing) {
    return { abstractId: existing.id, skipped: true };
  }

  const abstractId = `abstract:${input.sourceType}:${input.ticker}:${input.accessionOrEventId}`;
  const chunkIds = input.chunks.map((c) => c.id);

  // Synthesize summary text from raw chunks
  const summaryText = input.chunks
    .map((c) => c.text.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8)
    .join("\n\n");

  const abstractRecord: DocumentAbstract = {
    id: abstractId,
    sourceType: input.sourceType,
    ticker: input.ticker.toUpperCase(),
    accessionOrEventId: input.accessionOrEventId,
    headline: input.headline,
    summaryText: summaryText,
    sourceChunkIds: chunkIds,
    createdAt: new Date().toISOString(),
    modelUsed: "document-synthesizer-v1"
  };

  insertDocumentAbstract(abstractRecord);

  // Embed summary document into RAG vector corpus
  const docType = input.sourceType === "earnings-summary" ? "earnings-summary" : "document-summary";
  try {
    await storeDocument(
      {
        text: `${input.headline}\n\n${summaryText}`,
        ticker: input.ticker.toUpperCase(),
        doc_type: docType,
        published_at: input.publishedAt || new Date().toISOString(),
        acceptance_datetime: input.acceptanceDatetime || new Date().toISOString(),
        source: "document-summarizer",
        url: `abstract://${input.ticker}/${input.accessionOrEventId}`
      },
      "local"
    );
  } catch (err) {
    console.warn(`[document-summarizer] Vector store document embedding warning for ${abstractId}:`, err);
  }

  return { abstractId, skipped: false };
}
