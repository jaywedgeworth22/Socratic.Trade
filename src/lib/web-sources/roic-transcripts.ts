// ROIC.ai earnings-call transcript ingestion -> shared RAG corpus.
//
// Ingests full earnings call transcripts from ROIC.ai (/v2/transcript/{symbol}/{year}/{quarter})
// into the shared RAG vector store (doc_type "earnings-transcript", source "roic-earnings-transcript").
// Leverages the user's high-capacity ROIC.ai individual subscription to bypass free-tier rate limits.

import { fetchWithRetry } from "../data-providers";
import { audit } from "../db";
import { resolveApiKeyWithSource } from "../db-api-keys";
import { logApiHealth } from "../db-health";
import { normalizeSymbol } from "../money";
import { storeDocument } from "../vector-db";

export const ROIC_TRANSCRIPT_DOC_TYPE = "earnings-transcript";
export const ROIC_TRANSCRIPT_SOURCE = "roic-earnings-transcript";

const ROIC_BASE = "https://api.roic.ai/v2";

export interface RoicTranscriptItem {
  symbol: string;
  year: number;
  quarter: number;
  date?: string;
  content: string;
}

export function parseRoicTranscriptResponse(
  json: unknown,
  symbol: string,
  year: number,
  quarter: number
): RoicTranscriptItem | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const rawContent = obj.transcript ?? obj.content ?? obj.text ?? obj.body;
  if (typeof rawContent !== "string" || rawContent.trim().length < 200) {
    return null;
  }
  const date = typeof obj.date === "string" ? obj.date : undefined;
  return {
    symbol: normalizeSymbol(symbol),
    year,
    quarter,
    date,
    content: rawContent.trim()
  };
}

export async function fetchRoicTranscript(
  symbol: string,
  year: number,
  quarter: number,
  userId?: string
): Promise<RoicTranscriptItem | null> {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;

  const keyInfo = resolveApiKeyWithSource("roic", userId);
  if (!keyInfo.key) return null;

  const url = `${ROIC_BASE}/transcript/${encodeURIComponent(normalized)}/${year}/${quarter}?apikey=${encodeURIComponent(keyInfo.key)}`;
  try {
    const res = await fetchWithRetry(
      url,
      {},
      {
        service: "roic",
        keySource: keyInfo.source,
        userId,
        suppressHealthStatuses: [404, 429]
      }
    );
    if (!res || !res.ok) return null;
    const json = await res.json();
    return parseRoicTranscriptResponse(json, normalized, year, quarter);
  } catch (err) {
    console.warn(`[roic-transcripts] failed to fetch transcript for ${normalized} Q${quarter} ${year}:`, err);
    return null;
  }
}

export async function ingestRoicTranscriptToRag(
  transcript: RoicTranscriptItem,
  userId?: string
): Promise<boolean> {
  if (!transcript.content || transcript.content.length < 200) return false;

  const doc_id = `roic-transcript-${transcript.symbol.toLowerCase()}-${transcript.year}-q${transcript.quarter}`;
  const title = `${transcript.symbol} Q${transcript.quarter} ${transcript.year} Earnings Call Transcript`;

  try {
    const result = await storeDocument(
      {
        doc_id,
        title,
        doc_type: ROIC_TRANSCRIPT_DOC_TYPE,
        source: ROIC_TRANSCRIPT_SOURCE,
        text: transcript.content,
        ticker: transcript.symbol,
        published_at: transcript.date ?? `${transcript.year}-Q${transcript.quarter}`
      },
      userId ?? "local"
    );

    if (result && !result.error && (result.indexed > 0 || result.attempted > 0)) {
      audit("roic_transcript_ingested", {
        symbol: transcript.symbol,
        year: transcript.year,
        quarter: transcript.quarter,
        doc_id,
        userId
      });
      logApiHealth({
        service: "roic",
        ok: true,
        errorText: `Ingested ${transcript.symbol} Q${transcript.quarter} ${transcript.year} transcript into RAG`,
        userId
      });
      return true;
    }
    return false;
  } catch (err) {
    console.error(`[roic-transcripts] failed to store RAG document for ${doc_id}:`, err);
    return false;
  }
}
