// Structure-aware document chunking for RAG ingestion. Ported from the Atlas BFF
// (reference/atlas-public-src/bff/rag/chunk.mjs) into TypeScript with no external deps:
// headings set section metadata, tables are kept atomic, long prose is split with overlap, and
// each chunk carries a deterministic context header plus a point-in-time `acceptance_datetime`.

import { createHash, randomUUID } from "crypto";

export const DEFAULT_MAX_TOKENS = 480;
const DEFAULT_OVERLAP_RATIO = 0.12;

/**
 * Rough chars-per-token ceiling used to size a downstream char cap from a token budget. English
 * prose averages ~5–6 chars/token; markdown tables (pipe-delimited, kept atomic by chunkDocument)
 * run longer per token because of `|`/whitespace padding. 8 is a deliberately generous upper bound
 * so a legitimately atomic, already-token-bounded chunk is never truncated downstream — it only
 * needs to cover the worst case, not be a tight estimate.
 */
export const CHARS_PER_TOKEN_CEILING = 8;

/** Hash chunk text with SHA-256 for dedup (cheaper than re-embedding via Voyage). */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export interface ChunkInput {
  text: string;
  doc_id?: string;
  title?: string;
  ticker?: string | string[];
  published_at?: string | number | Date;
  acceptance_datetime?: string | number | Date;
  doc_type?: string;
  source?: string;
  url?: string;
}

export interface DocumentChunk {
  doc_id: string;
  chunk_id: string;
  title: string;
  text: string;
  /** SHA-256 hex (first 16 chars) of chunk text for re-embed dedup. */
  content_hash: string;
  context_header: string;
  ticker: string[];
  doc_type: string;
  section: string;
  published_at: string;
  acceptance_datetime: string;
  source: string;
  url: string;
  is_table: boolean;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapRatio?: number;
}

type Block = { type: "heading" | "paragraph" | "table"; text: string };

/** Uppercase and strip to a bare ticker symbol (`A-Z` and `.`). */
export function canonicalTicker(value: string): string {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z.]/g, "");
}

function normalizeTickerList(ticker: string | string[] | undefined): string[] {
  const raw = Array.isArray(ticker) ? ticker : String(ticker ?? "").split(",");
  return raw.map((t) => canonicalTicker(t)).filter(Boolean);
}

function normalizeDate(value: string | number | Date | undefined, fallback: string): string {
  if (!value) return fallback;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** Approximate token count via whitespace word count (deterministic, dependency-free). */
function countTokens(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function tailOverlap(text: string, count: number): string {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return words.slice(Math.max(0, words.length - count)).join(" ");
}

function splitLongProse(text: string, maxTokens: number, overlapTokens: number): string[] {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const step = Math.max(1, maxTokens - overlapTokens);
  const segments: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    segments.push(words.slice(i, i + maxTokens).join(" "));
    if (i + maxTokens >= words.length) break;
  }
  return segments;
}

function isHeading(line: string): boolean {
  return /^(#{1,6}\s+.+|item\s+\d+[a-z]?[.\s-].+|risk factors|management'?s discussion|financial statements)$/i.test(
    line.trim()
  );
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function isTableLine(line: string): boolean {
  return /^\s*\|.+\|\s*$/.test(line);
}

function blockDocument(text: string): Block[] {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const joined = paragraph.join(" ").trim();
    if (joined) blocks.push({ type: "paragraph", text: joined });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isTableLine(line)) {
      flushParagraph();
      const table: string[] = [];
      while (i < lines.length && isTableLine(lines[i] ?? "")) table.push(lines[i++] ?? "");
      i--;
      blocks.push({ type: "table", text: table.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    if (isHeading(line)) {
      flushParagraph();
      blocks.push({ type: "heading", text: headingText(line) });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

function makeHeader(args: {
  ticker: string[];
  doc_type: string;
  section: string;
  source: string;
  acceptance_datetime: string;
  title: string;
}): string {
  const { ticker, doc_type, section, source, acceptance_datetime, title } = args;
  const entity = ticker.length ? ticker.join(",") : title;
  return [
    `Document: ${entity}${doc_type ? ` ${doc_type}` : ""}.`,
    `Section: ${section || "General"}.`,
    source ? `Source: ${source}.` : "",
    acceptance_datetime ? `Accepted: ${acceptance_datetime}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Split a document into structure-aware chunks. Headings update the running `section`; tables are
 * emitted atomically; oversize prose is windowed with overlap. Each chunk carries a deterministic
 * `context_header` and `acceptance_datetime` for citation + point-in-time retrieval.
 */
export function chunkDocument(doc: ChunkInput, options: ChunkOptions = {}): DocumentChunk[] {
  if (!doc?.text || typeof doc.text !== "string") throw new Error("doc.text required");
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapRatio = options.overlapRatio ?? DEFAULT_OVERLAP_RATIO;

  const doc_id = doc.doc_id || randomUUID();
  const title = doc.title || doc_id;
  const ticker = normalizeTickerList(doc.ticker);
  const published_at = normalizeDate(doc.published_at, new Date().toISOString());
  const acceptance_datetime = normalizeDate(doc.acceptance_datetime, published_at);
  const doc_type = doc.doc_type || "note";
  const source = doc.source || "user";
  const url = doc.url || "";
  const overlapTokens = Math.max(0, Math.floor(maxTokens * overlapRatio));

  let section = title;
  let pending: string[] = [];
  const chunks: DocumentChunk[] = [];

  const pushText = (text: string, opts: { isTable?: boolean } = {}) => {
    const clean = String(text).trim();
    if (!clean) return;
    const n = chunks.length + 1;
    const context_header = makeHeader({ ticker, doc_type, section, source, acceptance_datetime, title });
    chunks.push({
      doc_id,
      chunk_id: `${doc_id}#c${String(n).padStart(3, "0")}`,
      title,
      text: clean,
      content_hash: hashContent(clean),
      context_header,
      ticker,
      doc_type,
      section,
      published_at,
      acceptance_datetime,
      source,
      url,
      is_table: Boolean(opts.isTable),
    });
  };

  const flush = (opts: { carryOverlap?: boolean } = {}) => {
    const carryOverlap = opts.carryOverlap ?? true;
    const text = pending.join("\n\n").trim();
    if (!text) {
      pending = [];
      return;
    }
    pushText(text);
    pending = carryOverlap && overlapTokens ? [tailOverlap(text, overlapTokens)] : [];
  };

  for (const block of blockDocument(doc.text)) {
    if (block.type === "heading") {
      flush({ carryOverlap: false });
      section = block.text;
      continue;
    }
    if (block.type === "table") {
      flush({ carryOverlap: false });
      pushText(block.text, { isTable: true });
      pending = [];
      continue;
    }
    if (countTokens(block.text) > maxTokens) {
      flush();
      for (const segment of splitLongProse(block.text, maxTokens, overlapTokens)) pushText(segment);
      pending = [];
      continue;
    }

    const proposed = [...pending, block.text].join("\n\n");
    if (pending.length && countTokens(proposed) > maxTokens) flush();
    pending.push(block.text);
  }
  flush({ carryOverlap: false });

  return chunks;
}
