// Token-budget packing for embed POSTs.
//
// OpenRouter `baai/bge-m3` is served by DeepInfra, which sums EVERY string in
// `input: string[]` against the model's 8192-token context.  A count-only batch
// (`VECTOR_EMBED_BATCH_SIZE=32` in prod) of ordinary ~256-token chunks hits 8193
// and 400s the whole lane.  Pack by estimated tokens (and a conservative byte
// cap) so Infisical can keep the count at 32 without ever sending that request.

import { approxTokens } from "../rag-metering";

/** DeepInfra/bge-m3 context.  A request at this size 400s. */
export const EMBED_MODEL_CONTEXT_TOKENS = 8192;

/**
 * Per-request token headroom.  Do not aim at 8192 — live receipts failed at 8193.
 * Uses the same estimator as rag_usage (`approxTokens`, UTF-8 bytes / 4).
 */
export const EMBED_REQUEST_TOKEN_BUDGET = 7500;

/**
 * Extra byte cap so a `VECTOR_CONTEXT_MAX_CHARS=2400` batch cannot sneak past
 * 8192 if DeepInfra tokenizes denser than bytes/4.  2.5 bytes/token * 7500.
 */
export const EMBED_REQUEST_BYTE_BUDGET = 18_750;

export interface EmbedTextRef {
  text: string;
  sourceIndex: number;
}

export function embedTextByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function embedTextTokenEstimate(text: string): number {
  return approxTokens([text]);
}

export function embedRequestFits(
  texts: readonly string[],
  tokenBudget: number = EMBED_REQUEST_TOKEN_BUDGET,
  byteBudget: number = EMBED_REQUEST_BYTE_BUDGET
): boolean {
  if (texts.length === 0) return true;
  let bytes = 0;
  for (const text of texts) {
    bytes += embedTextByteLength(text);
    if (bytes > byteBudget) return false;
  }
  return approxTokens([...texts]) <= tokenBudget;
}

function hardSplitByBytes(text: string, maxBytes: number): string[] {
  if (maxBytes < 1) return [text];
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return [text];
  const pieces: string[] = [];
  let offset = 0;
  while (offset < encoded.length) {
    let end = Math.min(offset + maxBytes, encoded.length);
    while (end > offset && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    if (end <= offset) end = Math.min(offset + maxBytes, encoded.length);
    pieces.push(encoded.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return pieces.filter((piece) => piece.length > 0);
}

function splitOversizedPart(part: string, tokenBudget: number, byteBudget: number): string[] {
  if (embedRequestFits([part], tokenBudget, byteBudget)) return [part];
  const byParagraph = part.split(/\n\n+/);
  if (byParagraph.length > 1) {
    return packTextPieces(byParagraph, tokenBudget, byteBudget, "\n\n");
  }
  const byLine = part.split(/\n/);
  if (byLine.length > 1) {
    return packTextPieces(byLine, tokenBudget, byteBudget, "\n");
  }
  const words = part.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return packTextPieces(words, tokenBudget, byteBudget, " ");
  }
  return hardSplitByBytes(part, byteBudget);
}

function packTextPieces(
  parts: readonly string[],
  tokenBudget: number,
  byteBudget: number,
  joiner: string
): string[] {
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) pieces.push(current);
    current = "";
  };
  for (const part of parts) {
    if (!part) continue;
    const candidate = current.length > 0 ? `${current}${joiner}${part}` : part;
    if (embedRequestFits([candidate], tokenBudget, byteBudget)) {
      current = candidate;
      continue;
    }
    flush();
    if (embedRequestFits([part], tokenBudget, byteBudget)) {
      current = part;
      continue;
    }
    pieces.push(...splitOversizedPart(part, tokenBudget, byteBudget));
  }
  flush();
  return pieces;
}

/** Split one over-limit string into in-window pieces.  In-window text is returned unchanged. */
export function splitTextToEmbedWindow(
  text: string,
  tokenBudget: number = EMBED_REQUEST_TOKEN_BUDGET,
  byteBudget: number = EMBED_REQUEST_BYTE_BUDGET
): string[] {
  if (embedRequestFits([text], tokenBudget, byteBudget)) return [text];
  return splitOversizedPart(text, tokenBudget, byteBudget);
}

/**
 * Pack already-in-window texts so each request stays under the token/byte budgets
 * and under `maxCount`.  `maxCount` is a ceiling (prod may be 32), not a target.
 */
export function packInWindowTexts(
  items: readonly EmbedTextRef[],
  options?: {
    tokenBudget?: number;
    byteBudget?: number;
    maxCount?: number;
  }
): EmbedTextRef[][] {
  const tokenBudget = options?.tokenBudget ?? EMBED_REQUEST_TOKEN_BUDGET;
  const byteBudget = options?.byteBudget ?? EMBED_REQUEST_BYTE_BUDGET;
  const maxCount = Math.max(1, options?.maxCount ?? Number.POSITIVE_INFINITY);
  const groups: EmbedTextRef[][] = [];
  let current: EmbedTextRef[] = [];

  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };

  for (const item of items) {
    if (!embedRequestFits([item.text], tokenBudget, byteBudget)) {
      flush();
      groups.push([item]);
      continue;
    }
    const next = [...current, item];
    const nextTexts = next.map((entry) => entry.text);
    if (
      current.length > 0 &&
      (next.length > maxCount || !embedRequestFits(nextTexts, tokenBudget, byteBudget))
    ) {
      flush();
    }
    current.push(item);
  }
  flush();
  return groups;
}

export function meanPoolEmbeddings(vectors: readonly number[][]): number[] {
  const first = vectors[0];
  if (!first || first.length === 0) {
    throw new Error("mean-pool requires at least one non-empty embedding");
  }
  const dim = first.length;
  const out = new Array<number>(dim).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dim) {
      throw new Error("mean-pool embeddings must share one dimension");
    }
    for (let i = 0; i < dim; i++) out[i]! += vector[i]!;
  }
  const n = vectors.length;
  for (let i = 0; i < dim; i++) out[i]! /= n;
  return out;
}
