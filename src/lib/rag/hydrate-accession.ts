// Local-only money-path hydrate (PR B).  No EDGAR, no fetch, fail-open.
// Order: worker chunks.json -> local artifact/sections.json -> FTS on the bare
// SEC accession -> earningscalls_transcripts / ROIC sidecar.

import fs from "fs";
import path from "path";
import { getDb } from "../db";
import { readRoicTranscriptArtifact } from "../roic-archive-artifacts";
import {
  listSecAccessionDirs,
  padCik10,
  readFirstExistingSync,
  secArtifactReadPaths
} from "./corpus-layout";
import { bareSecAccession, parseItemCodeFromSection } from "./pinecone-write-class";

export const HYDRATE_WALL_MS = 150;

export type HydrateMissReason =
  | "missing_local_copy"
  | "hydrate_budget"
  | "empty_text"
  | "invalid_accession";

export type HydrateSource = "chunks.json" | "artifact" | "fts" | "transcript";

export interface HydrateAccessionInput {
  accession: string;
  content_hash?: string;
  itemCode?: string;
  symbol?: string;
  /** Injected clock for tests. */
  nowMs?: () => number;
  wallMs?: number;
}

export interface HydrateAccessionResult {
  text: string;
  missedReason?: HydrateMissReason;
  source?: HydrateSource;
  contentHash?: string;
  itemCode?: string;
}

const TRANSCRIPT_ACC_RE = /^(?:earningscalls|roic):([A-Z0-9.]+):(\d{4})Q([1-4])$/i;
const HEX32_RE = /^[a-f0-9]{32}$/i;

type LocalChunk = {
  text?: string;
  parent_text?: string;
  content_hash?: string;
  section?: string;
  itemCode?: string;
};

function nowFn(input: HydrateAccessionInput): () => number {
  return input.nowMs ?? Date.now;
}

function timedOut(started: number, input: HydrateAccessionInput): boolean {
  return nowFn(input)() - started >= (input.wallMs ?? HYDRATE_WALL_MS);
}

function miss(reason: HydrateMissReason): HydrateAccessionResult {
  return { text: "", missedReason: reason };
}

function hit(text: string, source: HydrateSource, extra?: Partial<HydrateAccessionResult>): HydrateAccessionResult {
  const trimmed = text.trim();
  if (!trimmed) return miss("empty_text");
  return { text: trimmed, source, ...extra };
}

function wantedItemCode(itemCode: string | undefined): string {
  return String(itemCode ?? "")
    .trim()
    .replace(/^item\s+/i, "")
    .replace(/\.$/, "");
}

function chunkItemCode(chunk: LocalChunk): string {
  const fromField = String(chunk.itemCode ?? "").trim();
  if (fromField) return fromField.replace(/^item\s+/i, "");
  return parseItemCodeFromSection(chunk.section);
}

function chunkBody(chunk: LocalChunk): string {
  const parent = String(chunk.parent_text ?? "").trim();
  if (parent) return parent;
  return String(chunk.text ?? "").trim();
}

function pickFromLocalChunks(
  chunks: LocalChunk[],
  input: HydrateAccessionInput
): { text: string; contentHash?: string; itemCode?: string } | null {
  if (chunks.length === 0) return null;
  const hash = String(input.content_hash ?? "").trim();
  if (hash) {
    const byHash = chunks.find((chunk) => String(chunk.content_hash ?? "").trim() === hash);
    if (byHash) {
      const text = chunkBody(byHash);
      if (text) return { text, contentHash: hash, itemCode: chunkItemCode(byHash) };
    }
  }
  const item = wantedItemCode(input.itemCode);
  if (item) {
    const matched = chunks.filter((chunk) => {
      const code = chunkItemCode(chunk);
      return code.toLowerCase() === item.toLowerCase();
    });
    if (matched.length > 0) {
      const text = matched.map(chunkBody).filter(Boolean).join("\n\n");
      if (text) return { text, itemCode: item, contentHash: matched[0]?.content_hash };
    }
  }
  const oneA = chunks.filter((chunk) => chunkItemCode(chunk).toUpperCase() === "1A");
  if (oneA.length > 0) {
    const text = oneA.map(chunkBody).filter(Boolean).join("\n\n");
    if (text) return { text, itemCode: "1A", contentHash: oneA[0]?.content_hash };
  }
  const first = chunks[0];
  const text = chunkBody(first);
  if (text) return { text, contentHash: first.content_hash, itemCode: chunkItemCode(first) };
  return null;
}

function parseChunksJson(raw: string): LocalChunk[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && typeof row === "object") as LocalChunk[];
  } catch {
    return [];
  }
}

function parseSectionsJson(raw: string): LocalChunk[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>).map((row) => ({
      itemCode: typeof row.itemCode === "string" ? row.itemCode : undefined,
      section:
        typeof row.itemCode === "string" && typeof row.itemTitle === "string"
          ? `${row.itemCode}. ${row.itemTitle}`
          : typeof row.itemTitle === "string"
            ? row.itemTitle
            : undefined,
      text: typeof row.text === "string" ? row.text : "",
      parent_text: typeof row.text === "string" ? row.text : ""
    }));
  } catch {
    return [];
  }
}

function lookupCik(accession: string, symbol?: string): string | null {
  try {
    const db = getDb();
    const byAcc = db
      .prepare("SELECT cik FROM sec_filings WHERE accession = ? LIMIT 1")
      .get(accession) as { cik?: string } | undefined;
    if (byAcc?.cik) return padCik10(byAcc.cik);
    const ticker = String(symbol ?? "").trim().toUpperCase();
    if (ticker) {
      const byTick = db
        .prepare("SELECT cik FROM sec_filings WHERE ticker = ? LIMIT 1")
        .get(ticker) as { cik?: string } | undefined;
      if (byTick?.cik) return padCik10(byTick.cik);
    }
  } catch {
    // schema may be absent in lightweight tests
  }
  return null;
}

function loadChunksJson(accession: string, cik: string | null): string | null {
  const candidates: string[] = [];
  if (cik) {
    candidates.push(...secArtifactReadPaths(cik, accession, 1, "chunks.json"));
  }
  for (const dir of listSecAccessionDirs(accession)) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith("-chunks.json") || name === "chunks.json") {
          candidates.push(path.join(dir, name));
        }
      }
    } catch {
      // skip
    }
  }
  return readFirstExistingSync(candidates);
}

function loadSectionsJson(accession: string, cik: string | null): string | null {
  const candidates: string[] = [];
  if (cik) {
    candidates.push(...secArtifactReadPaths(cik, accession, 1, "sections.json"));
  }
  for (const dir of listSecAccessionDirs(accession)) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith("-sections.json") || name === "sections.json") {
          candidates.push(path.join(dir, name));
        }
      }
    } catch {
      // skip
    }
  }
  return readFirstExistingSync(candidates);
}

function hydrateFromFts(
  accession: string,
  input: HydrateAccessionInput
): HydrateAccessionResult | null {
  try {
    const db = getDb();
    const hash = String(input.content_hash ?? "").trim();
    const params: string[] = [accession, accession, accession];
    let sql = `
      SELECT content_hash, text FROM document_chunks_fts
      WHERE accession = ?
         OR accession GLOB ('*:' || ? || ':*')
         OR accession GLOB (? || ':*')
    `;
    if (hash && HEX32_RE.test(hash)) {
      sql += " AND content_hash = ?";
      params.push(hash);
    }
    sql += " LIMIT 24";
    const rows = db.prepare(sql).all(...params) as Array<{ content_hash?: string; text?: string }>;
    const texts = rows.map((row) => String(row.text ?? "").trim()).filter(Boolean);
    if (texts.length === 0) return null;
    const item = wantedItemCode(input.itemCode);
    if (item) {
      const filtered = rows
        .map((row) => String(row.text ?? "").trim())
        .filter((text) => new RegExp(`\\bitem\\s*${item.replace(".", "\\.")}\\b`, "i").test(text) || text.startsWith(`[${item}`));
      if (filtered.length > 0) {
        return hit(filtered.join("\n\n"), "fts", { contentHash: hash || undefined, itemCode: item });
      }
    }
    return hit(texts.join("\n\n"), "fts", {
      contentHash: hash || rows[0]?.content_hash,
      itemCode: input.itemCode
    });
  } catch {
    return null;
  }
}

function hydrateTranscript(accession: string, input: HydrateAccessionInput): HydrateAccessionResult | null {
  const match = TRANSCRIPT_ACC_RE.exec(accession);
  const symbolFromAcc = match?.[1]?.toUpperCase();
  const year = match ? Number(match[2]) : NaN;
  const quarter = match ? Number(match[3]) : NaN;
  const symbol = String(input.symbol ?? symbolFromAcc ?? "").trim().toUpperCase();

  try {
    const db = getDb();
    if (symbol && Number.isFinite(year) && Number.isFinite(quarter)) {
      const row = db
        .prepare(
          `SELECT content FROM earningscalls_transcripts
           WHERE symbol = ? AND fiscal_year = ? AND fiscal_quarter = ?
             AND content IS NOT NULL AND length(content) > 80
           LIMIT 1`
        )
        .get(symbol, year, quarter) as { content?: string } | undefined;
      if (row?.content) return hit(row.content, "transcript");
    }
    const like = `%${accession}%`;
    const byMeta = db
      .prepare(
        `SELECT content FROM earningscalls_transcripts
         WHERE content IS NOT NULL AND length(content) > 80
           AND (source_meta LIKE ? OR lower(symbol) = lower(?))
         ORDER BY fiscal_year DESC, fiscal_quarter DESC
         LIMIT 1`
      )
      .get(like, symbol || accession) as { content?: string } | undefined;
    if (byMeta?.content) return hit(byMeta.content, "transcript");
  } catch {
    // table may be absent
  }

  if (symbol && Number.isFinite(year) && Number.isFinite(quarter)) {
    const artifact = readRoicTranscriptArtifact(symbol, year, quarter);
    if (artifact?.content) return hit(artifact.content, "transcript");
  }
  return null;
}

export function normalizeHydrateAccession(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  if (TRANSCRIPT_ACC_RE.test(trimmed)) return trimmed;
  return bareSecAccession(trimmed) ?? trimmed;
}

export async function hydrateAccession(input: HydrateAccessionInput): Promise<HydrateAccessionResult> {
  const started = nowFn(input)();
  try {
    const accession = normalizeHydrateAccession(input.accession);
    if (!accession) return miss("invalid_accession");

    if (TRANSCRIPT_ACC_RE.test(accession)) {
      const transcript = hydrateTranscript(accession, input);
      if (transcript) return transcript;
      if (timedOut(started, input)) return miss("hydrate_budget");
      return miss("missing_local_copy");
    }

    if (timedOut(started, input)) return miss("hydrate_budget");
    const cik = lookupCik(accession, input.symbol);

    if (timedOut(started, input)) return miss("hydrate_budget");
    const chunksRaw = loadChunksJson(accession, cik);
    if (chunksRaw) {
      const picked = pickFromLocalChunks(parseChunksJson(chunksRaw), input);
      if (picked?.text) return hit(picked.text, "chunks.json", picked);
    }

    if (timedOut(started, input)) return miss("hydrate_budget");
    const sectionsRaw = loadSectionsJson(accession, cik);
    if (sectionsRaw) {
      const picked = pickFromLocalChunks(parseSectionsJson(sectionsRaw), input);
      if (picked?.text) return hit(picked.text, "artifact", picked);
    }

    if (timedOut(started, input)) return miss("hydrate_budget");
    const fts = hydrateFromFts(accession, input);
    if (fts) return fts;

    if (timedOut(started, input)) return miss("hydrate_budget");
    const transcript = hydrateTranscript(accession, input);
    if (transcript) return transcript;

    return miss("missing_local_copy");
  } catch {
    return miss("missing_local_copy");
  }
}
