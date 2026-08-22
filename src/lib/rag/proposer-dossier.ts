// PR B money-path dossier: SQLite abstracts + retrieveContextDetailed + local hydrate.
// Does not raise k.  Coverage is a receipt.  Does not flip RAG_PINECONE_WRITE_CLASS.

import { getDocumentAbstractsForTicker, type DocumentAbstract } from "../db-document-abstracts";
import { normalizeSymbol } from "../money";
import type { RetrievedChunk, RetrieveOptions } from "../vector-db";
import { envFlagOn } from "./env-flag";
import { hydrateAccession, HYDRATE_WALL_MS } from "./hydrate-accession";
import { isCompactRagSummaryDocType, orderChunksForProposer } from "./proposer-format";
import { bareSecAccession, parseItemCodeFromSection } from "./pinecone-write-class";

export const SCOUT_STUB_CHARS = 1_200;
export const HYDRATE_ACCESSION_CAP = 8;
export const DEEP_COVERAGE_TYPES = ["10-k", "10-q", "8-k", "earnings-transcript"] as const;

export function proposerDossierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagOn("RAG_PROPOSER_DOSSIER", true, env);
}

export interface ProposerDossierAbstract {
  accession: string;
  sourceType: string;
  headline: string;
  summaryText: string;
}

export interface ProposerDossierCoverage {
  want: string[];
  have: string[];
  missing: string[];
  hydrateMisses: string[];
}

export interface ProposerDossier {
  symbol: string;
  depth: "deep" | "scout";
  abstracts: ProposerDossierAbstract[];
  chunks: RetrievedChunk[];
  factsCard: string;
  insiderCard: string;
  coverage: ProposerDossierCoverage;
}

export interface AssembleProposerDossierInput {
  symbol: string;
  depth: "deep" | "scout";
  query: string;
  userId?: string;
  limit?: number;
  retrieveOptions?: RetrieveOptions;
  retrieve?: (
    query: string,
    symbol: string,
    limit?: number,
    userId?: string,
    options?: RetrieveOptions
  ) => Promise<RetrievedChunk[]>;
  nowMs?: () => number;
}

function coverageKey(sourceType: string): string {
  const t = sourceType.toLowerCase();
  if (t.includes("10k") || t.includes("10-k")) return "10-k";
  if (t.includes("10q") || t.includes("10-q")) return "10-q";
  if (t.includes("8k") || t.includes("8-k")) return "8-k";
  if (t.includes("earnings") || t.includes("transcript")) return "earnings-transcript";
  return t;
}

function compactDocTypeForAbstract(sourceType: string): string {
  const key = coverageKey(sourceType);
  if (key === "8-k") return "8k-brief";
  if (key === "earnings-transcript") return "earnings-summary";
  return "document-summary";
}

function truncateStub(text: string, max = SCOUT_STUB_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function abstractAccession(row: DocumentAbstract): string {
  return String(row.accessionOrEventId ?? "").trim();
}

function chunkAccessionKey(chunk: RetrievedChunk): string {
  const md = chunk.metadata ?? {};
  const candidates = [
    md.accession,
    md.accession_or_event_id,
    md.document_key,
    md.doc_id,
    chunk.id
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const bare = bareSecAccession(raw);
    if (bare) return bare;
    return raw.trim();
  }
  return "";
}

function sameAccession(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const bareA = bareSecAccession(a);
  const bareB = bareSecAccession(b);
  return Boolean(bareA && bareB && bareA === bareB);
}

function selectAbstracts(rows: DocumentAbstract[], depth: "deep" | "scout"): ProposerDossierAbstract[] {
  if (rows.length === 0) return [];
  if (depth === "scout") {
    const newest = rows[0];
    return [
      {
        accession: abstractAccession(newest),
        sourceType: newest.sourceType,
        headline: newest.headline,
        summaryText: truncateStub(newest.summaryText)
      }
    ];
  }
  const picked = new Map<string, ProposerDossierAbstract>();
  for (const row of rows) {
    const key = coverageKey(row.sourceType);
    if (!DEEP_COVERAGE_TYPES.includes(key as (typeof DEEP_COVERAGE_TYPES)[number])) continue;
    if (picked.has(key)) continue;
    picked.set(key, {
      accession: abstractAccession(row),
      sourceType: row.sourceType,
      headline: row.headline,
      summaryText: row.summaryText
    });
    if (picked.size >= DEEP_COVERAGE_TYPES.length) break;
  }
  return [...picked.values()];
}

function abstractToChunk(symbol: string, abstract: ProposerDossierAbstract): RetrievedChunk {
  return {
    id: `abstract:${abstract.sourceType}:${symbol}:${abstract.accession}`,
    text: abstract.summaryText,
    score: 1,
    source: "document-abstracts",
    doc_type: compactDocTypeForAbstract(abstract.sourceType),
    section: abstract.headline,
    metadata: {
      accession: abstract.accession,
      accession_or_event_id: abstract.accession
    }
  };
}

function chunkLooksLike1A(chunk: RetrievedChunk): boolean {
  const section = String(chunk.section ?? "");
  if (parseItemCodeFromSection(section).toUpperCase() === "1A") return true;
  return /\b1a\b/i.test(section);
}

function hashFromChunk(chunk: RetrievedChunk): string | undefined {
  const md = chunk.metadata ?? {};
  const raw = md.content_hash ?? md.contentHash;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function itemCodeFromChunk(chunk: RetrievedChunk): string | undefined {
  const md = chunk.metadata ?? {};
  if (typeof md.itemCode === "string" && md.itemCode.trim()) return md.itemCode.trim();
  const parsed = parseItemCodeFromSection(chunk.section);
  return parsed || undefined;
}

async function defaultRetrieve(
  query: string,
  symbol: string,
  limit?: number,
  userId?: string,
  options?: RetrieveOptions
): Promise<RetrievedChunk[]> {
  const { retrieveContextDetailed } = await import("../vector-db");
  return retrieveContextDetailed(query, symbol, limit, userId, options);
}

export async function assembleProposerDossier(
  input: AssembleProposerDossierInput
): Promise<ProposerDossier> {
  const symbol = normalizeSymbol(input.symbol);
  const depth = input.depth;
  const limit = input.limit ?? (depth === "deep" ? 8 : 1);
  const emptyCoverage: ProposerDossierCoverage = {
    want: depth === "deep" ? [...DEEP_COVERAGE_TYPES] : ["latest-abstract"],
    have: [],
    missing: depth === "deep" ? [...DEEP_COVERAGE_TYPES] : ["latest-abstract"],
    hydrateMisses: []
  };

  let rows: DocumentAbstract[] = [];
  try {
    rows = getDocumentAbstractsForTicker(symbol, 40);
  } catch {
    rows = [];
  }
  const abstracts = selectAbstracts(rows, depth);
  const inlinedAccessions = abstracts.map((row) => row.accession).filter(Boolean);
  const retrieve = input.retrieve ?? defaultRetrieve;
  const retrieved = await retrieve(input.query, symbol, limit, input.userId ?? "local", input.retrieveOptions);
  const ordered = orderChunksForProposer(retrieved);

  const suppressed: RetrievedChunk[] = [];
  for (const chunk of ordered) {
    if (isCompactRagSummaryDocType(chunk.doc_type)) {
      const key = chunkAccessionKey(chunk);
      if (inlinedAccessions.some((acc) => sameAccession(acc, key))) continue;
    }
    suppressed.push(chunk);
  }

  const abstractChunks = abstracts.map((row) => abstractToChunk(symbol, row));
  let combined: RetrievedChunk[];
  if (depth === "scout") {
    combined = abstractChunks.length > 0 ? abstractChunks.slice(0, 1) : suppressed.slice(0, 1);
  } else {
    const remainingSlots = Math.max(0, limit - abstractChunks.length);
    combined = [...abstractChunks, ...suppressed.slice(0, remainingSlots)];
  }

  const tenKAbstract = abstracts.find((row) => coverageKey(row.sourceType) === "10-k");
  const hydrateMisses: string[] = [];
  if (depth === "deep" && tenKAbstract && !combined.some(chunkLooksLike1A)) {
    const reserved = await hydrateAccession({
      accession: tenKAbstract.accession,
      itemCode: "1A",
      symbol,
      nowMs: input.nowMs
    });
    if (reserved.text) {
      const reservedChunk: RetrievedChunk = {
        id: `hydrate:1A:${tenKAbstract.accession}`,
        text: reserved.text,
        score: 0.99,
        source: "local-hydrate",
        doc_type: "10-k",
        section: "1A. Risk Factors",
        metadata: { accession: tenKAbstract.accession, itemCode: "1A" }
      };
      if (combined.length >= limit) combined = [...combined.slice(0, limit - 1), reservedChunk];
      else combined.push(reservedChunk);
    } else {
      hydrateMisses.push(`1A:${tenKAbstract.accession}`);
    }
  }

  const started = (input.nowMs ?? Date.now)();
  const seenAccessions = new Set<string>();
  const hydrateCache = new Map<string, Awaited<ReturnType<typeof hydrateAccession>>>();
  const hydratedChunks: RetrievedChunk[] = [];
  for (const chunk of combined) {
    const elapsed = (input.nowMs ?? Date.now)() - started;
    const key = chunkAccessionKey(chunk);
    if (!key || elapsed >= HYDRATE_WALL_MS) {
      hydratedChunks.push(chunk);
      continue;
    }
    if (!hydrateCache.has(key) && seenAccessions.size >= HYDRATE_ACCESSION_CAP) {
      hydratedChunks.push(chunk);
      continue;
    }
    seenAccessions.add(key);
    let local = hydrateCache.get(key);
    if (!local) {
      local = await hydrateAccession({
        accession: key,
        content_hash: hashFromChunk(chunk),
        itemCode: itemCodeFromChunk(chunk),
        symbol,
        nowMs: input.nowMs,
        wallMs: Math.max(1, HYDRATE_WALL_MS - elapsed)
      });
      hydrateCache.set(key, local);
    }
    if (local.missedReason) {
      hydrateMisses.push(`${key}:${local.missedReason}`);
      hydratedChunks.push(chunk);
      continue;
    }
    if (local.text && local.text.length > chunk.text.length) {
      hydratedChunks.push({ ...chunk, text: local.text });
    } else {
      hydratedChunks.push(chunk);
    }
  }

  const have = new Set<string>();
  for (const row of abstracts) have.add(coverageKey(row.sourceType));
  for (const chunk of hydratedChunks) {
    const t = String(chunk.doc_type ?? "").toLowerCase();
    if (t === "10-k" || t.includes("10k")) have.add("10-k");
    else if (t === "10-q" || t.includes("10q")) have.add("10-q");
    else if (t === "8-k" || t.endsWith("-brief")) have.add("8-k");
    else if (t.includes("earnings") || t.includes("transcript")) have.add("earnings-transcript");
  }
  const want = emptyCoverage.want;
  const missing = want.filter((item) => !have.has(item));

  return {
    symbol,
    depth,
    abstracts,
    chunks: hydratedChunks,
    factsCard: "",
    insiderCard: "",
    coverage: {
      want,
      have: [...have],
      missing,
      hydrateMisses
    }
  };
}
