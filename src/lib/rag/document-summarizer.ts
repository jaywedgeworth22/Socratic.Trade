// Document Summarizer Engine (Layer 3: Derived Abstracts & Summaries)
//
// Extracts structured abstracts and briefs from raw source chunks (10-K, 10-Q, 8-K, transcripts),
// links every extracted fact to source_chunk_ids, saves the structured summary into the relational DB
// `document_abstracts` table, and embeds the summary document into the RAG vector corpus.
//
// Design (owner 2026-08-05): for trading proposals the LLM needs BOTH full narrative (when
// retrieved) AND short highlights. Full bodies stay in their native doc_type; this path writes
// compact `document-summary` / `earnings-summary` vectors so retrieval can surface catalysts
// without stuffing multi-hundred-KB filings into every prompt.

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
 * Split long filing/transcript text into short trade-relevant pseudo-chunks (extractive,
 * no LLM spend). Prefer paragraph breaks and keyword-scored highlights (guidance, margins, etc.).
 */
export function tradeHighlightChunksFromText(
  text: string,
  opts?: { maxChunks?: number; maxCharsPerChunk?: number }
): Array<{ id: string; text: string }> {
  const maxChunks = opts?.maxChunks ?? 8;
  const maxChars = opts?.maxCharsPerChunk ?? 1_800;
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];
  const paras = cleaned
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 60);
  const pool = paras.length > 0 ? paras : [cleaned];
  const scored = pool
    .map((p, i) => {
      const lower = p.toLowerCase();
      let score = 0;
      for (const kw of [
        "guidance",
        "outlook",
        "revenue",
        "margin",
        "eps",
        "earnings",
        "demand",
        "backlog",
        "lawsuit",
        "investigation",
        "impairment",
        "restructuring",
        "acquisition",
        "divest",
        "ceo",
        "cfo",
        "risk factor",
        "material",
        "item 2.02",
        "item 5.02",
        "item 8.01",
        "item 1.01"
      ]) {
        if (lower.includes(kw)) score += 2;
      }
      score += Math.max(0, 3 - Math.floor(i / 3));
      return { p, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, maxChunks).map((row, idx) => ({
    id: `hl-${idx}`,
    text: row.p.slice(0, maxChars)
  }));
}

/**
 * Generates a cited summary abstract for a document, saves it to `document_abstracts`,
 * and embeds it into the RAG vector store with `doc_type: "document-summary"` or `"earnings-summary"`.
 */
export async function generateAndStoreDocumentAbstract(
  input: SummarizeDocumentInput
): Promise<SummarizeDocumentResult> {
  const db = getDb();

  const existing = db
    .prepare("SELECT id FROM document_abstracts WHERE accession_or_event_id = ? AND source_type = ?")
    .get(input.accessionOrEventId, input.sourceType) as { id: string } | undefined;

  if (existing) {
    return { abstractId: existing.id, skipped: true };
  }

  const abstractId = `abstract:${input.sourceType}:${input.ticker}:${input.accessionOrEventId}`;
  const chunkIds = input.chunks.map((c) => c.id);

  const summaryText = input.chunks
    .map((c) => c.text.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8)
    .join("\n\n");

  if (!summaryText || summaryText.length < 80) {
    return { abstractId, skipped: true, error: "summary_too_short" };
  }

  const abstractRecord: DocumentAbstract = {
    id: abstractId,
    sourceType: input.sourceType,
    ticker: input.ticker.toUpperCase(),
    accessionOrEventId: input.accessionOrEventId,
    headline: input.headline,
    summaryText,
    sourceChunkIds: chunkIds,
    createdAt: new Date().toISOString(),
    modelUsed: "document-synthesizer-v1"
  };

  insertDocumentAbstract(abstractRecord);

  const docType = input.sourceType === "earnings-summary" ? "earnings-summary" : "document-summary";
  try {
    await storeDocument(
      {
        text: `${input.headline}\n\n${summaryText}`,
        ticker: input.ticker.toUpperCase(),
        title: input.headline,
        doc_id: abstractId,
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
