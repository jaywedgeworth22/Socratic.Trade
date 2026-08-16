// ROIC.ai earnings-call transcript ingestion -> shared RAG corpus.
//
// Full transcripts from ROIC.ai:
//   v3 list: GET /v3.0.0/earnings-calls?identifier=EXCHANGE:SYM
//   v3 body: GET /v3.0.0/earnings-calls/{NASDAQ:SYM}?fiscal_year=&fiscal_quarter=
//   v2 fallback: GET /v2/company/earnings-calls/latest/{SYM} (latest only)
// into the shared RAG vector store (doc_type "earnings-transcript", source "roic-earnings-transcript").
// Prefer ROIC over free EarningsCalls previews when the owner has a paid/entitled ROIC key.
//
// Scheduler: refreshRoicTranscriptsIfDue (wired from scheduler.ts). Opt-in = ROIC key present;
// kill-switch ROIC_TRANSCRIPTS_DISABLED=1. Quarters-per-symbol follow Connections plan tier
// (free=2, individual=20, professional=40 app cap) unless ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL
// overrides. Per-run fetch budget follows the same tier (free-safe 8, Individual default 80).

import fs from "fs";
import path from "path";
import { fetchWithRetry } from "../data-providers";
import { audit } from "../db";
import {
  getUserApiKey,
  listUsers,
  listWatchlistSymbols,
  LOCAL_USER,
  resolveApiKeyWithSource
} from "../db-api-keys";
import { listRecentlyHeldSymbolsAllUsers, listRecentlyHeldSymbolValuesAllUsers } from "../db-fills";
import { logApiHealth } from "../db-health";
import { hasIngestedAccession, insertIngestedAccession } from "../db-learning";
import { getPolicy } from "../db-profiles";
import { getInternalSetting, setInternalSetting } from "../db-settings";
import { symbolsForPolicyUniverse } from "../index-universes";
import { normalizeSymbol } from "../money";
import { admitProviderRequests, withProviderLimit } from "../provider-rate-limit";
import { lookupRegisteredPlanTier, roicTranscriptQuartersForPlan } from "../provider-tier-plan";
import {
  ROIC_TRANSCRIPT_DOC_TYPE,
  ROIC_TRANSCRIPT_SOURCE,
  roicTranscriptsKillSwitchOn
} from "../roic-transcripts-gate";
import { resolveSourceNumber } from "../source-settings";
import { getTechnicalWatchlist } from "./technical";
import { hasPineconeWriteBudget, storeDocument } from "../vector-db";

export { ROIC_TRANSCRIPT_DOC_TYPE, ROIC_TRANSCRIPT_SOURCE, roicTranscriptsKillSwitchOn };

const ROIC_V3_BASE = "https://api.roic.ai/v3.0.0";
const ROIC_V2_BASE = "https://api.roic.ai/v2";
const LAST_COMPLETE_KEY = "webSource:roicTranscripts:lastCompleteAt";
const LAST_ATTEMPT_KEY = "webSource:roicTranscripts:lastAttemptAt";
const CURSOR_KEY = "webSource:roicTranscripts:cursor";
const DEFAULT_COMPLETE_TTL_HOURS = 6;
const DEFAULT_MAX_TRANSCRIPTS_PER_RUN_FREE = 8;
const DEFAULT_MAX_TRANSCRIPTS_PER_RUN_PAID = 80;

export function roicTranscriptAccession(symbol: string, year: number, quarter: number): string {
  return `roic:${normalizeSymbol(symbol)}:${year}Q${quarter}`;
}

/** Key present (user or env) and kill-switch off. */
export function roicTranscriptsEnabled(userId?: string): boolean {
  if (roicTranscriptsKillSwitchOn()) return false;
  return Boolean(resolveApiKeyWithSource("roic", userId).key);
}

function paidRoicPlan(userId?: string): boolean {
  let tier = lookupRegisteredPlanTier("roic");
  if (tier === undefined || tier === null) {
    try {
      const row = getUserApiKey(userId ?? LOCAL_USER, "roic");
      tier = row?.planTier ?? null;
    } catch {
      tier = null;
    }
  }
  const id = (tier ?? "").toLowerCase();
  return id === "individual" || id === "professional" || id === "enterprise";
}

function completeTtlMs(): number {
  const h = Number(process.env.ROIC_TRANSCRIPTS_TTL_HOURS ?? DEFAULT_COMPLETE_TTL_HOURS);
  return Math.max(1, Number.isFinite(h) ? h : DEFAULT_COMPLETE_TTL_HOURS) * 3_600_000;
}

function maxTranscriptsPerRun(userId?: string): number {
  const paid = paidRoicPlan(userId);
  const fallback = paid ? DEFAULT_MAX_TRANSCRIPTS_PER_RUN_PAID : DEFAULT_MAX_TRANSCRIPTS_PER_RUN_FREE;
  const cap = paid ? 300 : 20;
  const n = resolveSourceNumber("ROIC_TRANSCRIPTS_MAX_PER_RUN");
  const raw = Number.isFinite(n) ? n : fallback;
  return Math.max(1, Math.min(cap, Math.floor(raw)));
}

/** Effective quarters: env override wins, else Connections plan tier, else free-safe 2. */
export function quartersPerSymbol(userId?: string): number {
  const envRaw = process.env.ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return Math.max(1, Math.min(40, Math.floor(n)));
  }
  let tier = lookupRegisteredPlanTier("roic");
  if (tier === undefined || tier === null) {
    try {
      const row = getUserApiKey(userId ?? LOCAL_USER, "roic");
      tier = row?.planTier ?? null;
    } catch {
      tier = null;
    }
  }
  return roicTranscriptQuartersForPlan(tier);
}

/**
 * Most recent completed fiscal quarters to try (calendar approximation).
 * Used only when the vendor list endpoint is empty.  Earnings for calendar Q1
 * usually print in the following months — we walk backward from the previous
 * calendar quarter so we rarely request the current unfinished period.
 */
export function recentFiscalPeriods(
  now: Date = new Date(),
  count: number = quartersPerSymbol()
): Array<{ year: number; quarter: number }> {
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3);
  if (quarter === 0) {
    year -= 1;
    quarter = 4;
  }
  const out: Array<{ year: number; quarter: number }> = [];
  for (let i = 0; i < count; i++) {
    out.push({ year, quarter });
    quarter -= 1;
    if (quarter < 1) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}

export interface RoicCursor {
  queue: string[];
  updatedAt: string;
}

export function readRoicCursor(): RoicCursor | null {
  const raw = getInternalSetting<unknown>(CURSOR_KEY);
  if (!raw || typeof raw !== "object") return null;
  const queue = (raw as { queue?: unknown }).queue;
  if (!Array.isArray(queue)) return null;
  const symbols = queue.map((s) => normalizeSymbol(String(s))).filter(Boolean);
  const updatedAt = typeof (raw as { updatedAt?: unknown }).updatedAt === "string"
    ? (raw as { updatedAt: string }).updatedAt
    : "";
  return { queue: symbols, updatedAt };
}

function writeRoicCursor(queue: string[], nowIso: string): void {
  if (queue.length === 0) {
    setInternalSetting(CURSOR_KEY, null);
    return;
  }
  setInternalSetting(CURSOR_KEY, { queue, updatedAt: nowIso } satisfies RoicCursor);
}

export function isRoicTranscriptRefreshDue(now: number = Date.now()): boolean {
  if (!roicTranscriptsEnabled()) return false;
  const cursor = readRoicCursor();
  if (cursor && cursor.queue.length > 0) return true;
  const last = getInternalSetting<unknown>(LAST_COMPLETE_KEY) ?? getInternalSetting<unknown>(LAST_ATTEMPT_KEY);
  if (typeof last !== "string" || !last) return true;
  const ts = Date.parse(last);
  if (!Number.isFinite(ts)) return true;
  return now - ts >= completeTtlMs();
}

export interface RoicTranscriptRefreshResult {
  attempted: number;
  ingested: number;
  skippedNoContent: number;
  skippedAlreadyStored: number;
  symbolsConsidered: number;
  due: boolean;
  enabled: boolean;
  remaining: number;
}

export interface RoicTranscriptTurn {
  speaker: string;
  text: string;
}

export interface RoicTranscriptItem {
  symbol: string;
  year: number;
  quarter: number;
  date?: string;
  content: string;
  turns: RoicTranscriptTurn[];
}

export interface RoicCallIndexRow {
  id?: string;
  symbol: string;
  year: number;
  quarter: number;
  date?: string;
}

/** Join speaker turns or take a plain string body; reject short / empty. */
export function transcriptTextFromRoicPayload(raw: unknown): string | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.length >= 200 ? t : null;
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts: string[] = [];
  for (const turn of raw) {
    if (!turn || typeof turn !== "object") continue;
    const row = turn as Record<string, unknown>;
    const speaker = typeof row.speaker === "string" ? row.speaker.trim() : "";
    const text = typeof row.text === "string" ? row.text.trim() : typeof row.content === "string" ? row.content.trim() : "";
    if (!text) continue;
    parts.push(speaker ? `${speaker}: ${text}` : text);
  }
  const joined = parts.join("\n\n").trim();
  return joined.length >= 200 ? joined : null;
}

export function speakerTurnsFromRoicPayload(raw: unknown): RoicTranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: RoicTranscriptTurn[] = [];
  for (const turn of raw) {
    if (!turn || typeof turn !== "object") continue;
    const row = turn as Record<string, unknown>;
    const speaker = typeof row.speaker === "string" ? row.speaker.trim() : "";
    const text = typeof row.text === "string" ? row.text.trim() : typeof row.content === "string" ? row.content.trim() : "";
    if (!text) continue;
    turns.push({ speaker, text });
  }
  return turns;
}

/** Map a speaker label to a stable section role for RAG filters. */
export function roleOfSpeaker(speaker: string): string {
  const s = speaker.toLowerCase();
  if (!s) return "qa";
  if (/\boperator\b/.test(s)) return "operator";
  if (/\banalyst\b/.test(s) && !/\b(ceo|cfo|coo|officer|president)\b/.test(s)) return "analyst";
  if (/\b(ceo|cfo|coo|cto|chief|officer|president|director|management)\b/.test(s)) return "management";
  return "qa";
}

export function parseRoicTranscriptResponse(
  json: unknown,
  symbol: string,
  year: number,
  quarter: number
): RoicTranscriptItem | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const payload = obj.transcript ?? obj.content ?? obj.text ?? obj.body;
  const content = transcriptTextFromRoicPayload(payload);
  if (!content) return null;
  const date = typeof obj.date === "string" ? obj.date : undefined;
  const fy =
    typeof obj.fiscal_year === "number"
      ? obj.fiscal_year
      : typeof obj.year === "number"
        ? obj.year
        : year;
  const fq =
    typeof obj.fiscal_quarter === "number"
      ? obj.fiscal_quarter
      : typeof obj.quarter === "number"
        ? obj.quarter
        : quarter;
  return {
    symbol: normalizeSymbol(symbol),
    year: fy,
    quarter: fq,
    date,
    content,
    turns: speakerTurnsFromRoicPayload(payload)
  };
}

export function parseRoicEarningsCallList(json: unknown, fallbackSymbol: string): RoicCallIndexRow[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const rows = Array.isArray(obj.data) ? obj.data : Array.isArray(obj) ? obj : [];
  const out: RoicCallIndexRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const year = typeof rec.fiscal_year === "number" ? rec.fiscal_year : typeof rec.year === "number" ? rec.year : NaN;
    const quarter = typeof rec.fiscal_quarter === "number" ? rec.fiscal_quarter : typeof rec.quarter === "number" ? rec.quarter : NaN;
    if (!Number.isFinite(year) || !Number.isFinite(quarter) || quarter < 1 || quarter > 4) continue;
    const rawSym = typeof rec.symbol === "string" ? rec.symbol : fallbackSymbol;
    const symbol = normalizeSymbol(rawSym.includes(":") ? rawSym.slice(rawSym.indexOf(":") + 1) : rawSym);
    if (!symbol) continue;
    const date = typeof rec.date === "string" ? rec.date : undefined;
    const id = typeof rec.id === "string" ? rec.id : undefined;
    out.push({ id, symbol, year, quarter, date });
  }
  return out;
}

/**
 * Prefer exchange:ticker for v3 when we only have a bare symbol. US large-caps
 * commonly resolve as NASDAQ: or NYSE: — try NASDAQ first then bare path fails with 400.
 */
export function roicV3Identifiers(symbol: string): string[] {
  const s = normalizeSymbol(symbol);
  if (!s) return [];
  if (s.includes(":")) return [s];
  return [`NASDAQ:${s}`, `NYSE:${s}`, s];
}

export function publishedAtIso(date: string | undefined, year: number, quarter: number): string {
  if (date) {
    const ts = Date.parse(date);
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  const month = Math.min(12, Math.max(1, quarter * 3));
  return new Date(Date.UTC(year, month - 1, 28, 16, 0, 0)).toISOString();
}

async function roicGetJson(
  url: string,
  fetchOpts: { service: "roic"; keySource: "env" | "user" | "none"; userId?: string; suppressHealthStatuses: number[] }
): Promise<unknown | null> {
  const credKey = `${fetchOpts.keySource}:${fetchOpts.userId ?? ""}`;
  const allowed = admitProviderRequests("roic", credKey, 1);
  if (!allowed) return null;
  return withProviderLimit("roic", async () => {
    const res = await fetchWithRetry(url, {}, fetchOpts);
    if (!res || !res.ok) return null;
    return await res.json();
  });
}

export async function fetchRoicCallIndex(
  symbol: string,
  userId?: string
): Promise<RoicCallIndexRow[]> {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return [];
  const keyInfo = resolveApiKeyWithSource("roic", userId);
  if (!keyInfo.key) return [];
  const fetchOpts = {
    service: "roic" as const,
    keySource: keyInfo.source,
    userId,
    suppressHealthStatuses: [400, 404, 429] as number[]
  };
  for (const identifier of roicV3Identifiers(normalized)) {
    const url =
      `${ROIC_V3_BASE}/earnings-calls` +
      `?identifier=${encodeURIComponent(identifier)}` +
      `&limit=100&order=desc&apikey=${encodeURIComponent(keyInfo.key)}`;
    try {
      const json = await roicGetJson(url, fetchOpts);
      const rows = parseRoicEarningsCallList(json, normalized);
      if (rows.length > 0) return rows;
    } catch (err) {
      console.warn(
        `[roic-transcripts] v3 list failed for ${identifier}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return [];
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

  const fetchOpts = {
    service: "roic" as const,
    keySource: keyInfo.source,
    userId,
    suppressHealthStatuses: [400, 404, 429] as number[]
  };

  for (const identifier of roicV3Identifiers(normalized)) {
    const url =
      `${ROIC_V3_BASE}/earnings-calls/${encodeURIComponent(identifier)}` +
      `?fiscal_year=${year}&fiscal_quarter=${quarter}&format=json&apikey=${encodeURIComponent(keyInfo.key)}`;
    try {
      const json = await roicGetJson(url, fetchOpts);
      const parsed = parseRoicTranscriptResponse(json, normalized, year, quarter);
      if (parsed) return parsed;
    } catch (err) {
      console.warn(
        `[roic-transcripts] v3 fetch failed for ${identifier} Q${quarter} ${year}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  try {
    const latestUrl =
      `${ROIC_V2_BASE}/company/earnings-calls/latest/${encodeURIComponent(normalized)}` +
      `?apikey=${encodeURIComponent(keyInfo.key)}`;
    const json = await roicGetJson(latestUrl, fetchOpts);
    const parsed = parseRoicTranscriptResponse(json, normalized, year, quarter);
    if (parsed) {
      const matchesPeriod =
        (parsed.year === year && parsed.quarter === quarter) ||
        (typeof (json as { year?: unknown } | null)?.year !== "number" &&
          typeof (json as { quarter?: unknown } | null)?.quarter !== "number");
      if (matchesPeriod) return parsed;
    }
  } catch (err) {
    console.warn(
      `[roic-transcripts] v2 latest failed for ${normalized}:`,
      err instanceof Error ? err.message : err
    );
  }

  return null;
}

function speakerSections(item: RoicTranscriptItem): Array<{ itemCode: string; itemTitle: string; text: string }> {
  if (item.turns.length === 0) {
    return [{ itemCode: "transcript", itemTitle: "Full call", text: item.content }];
  }
  return item.turns.map((turn) => ({
    itemCode: roleOfSpeaker(turn.speaker),
    itemTitle: turn.speaker || "Speaker",
    text: turn.text
  }));
}

export async function ingestRoicTranscriptToRag(
  transcript: RoicTranscriptItem,
  userId?: string
): Promise<boolean> {
  if (!transcript.content || transcript.content.length < 200) return false;

  const doc_id = `roic-transcript-${transcript.symbol.toLowerCase()}-${transcript.year}-q${transcript.quarter}`;
  const accession = roicTranscriptAccession(transcript.symbol, transcript.year, transcript.quarter);
  const title = `${transcript.symbol} Q${transcript.quarter} ${transcript.year} Earnings Call Transcript`;
  const published = publishedAtIso(transcript.date, transcript.year, transcript.quarter);
  const observed = new Date().toISOString();

  try {
    const result = await storeDocument(
      {
        doc_id,
        title,
        doc_type: ROIC_TRANSCRIPT_DOC_TYPE,
        source: ROIC_TRANSCRIPT_SOURCE,
        text: transcript.content,
        ticker: transcript.symbol,
        published_at: published,
        acceptance_datetime: observed,
        sections: speakerSections(transcript)
      },
      userId ?? "local",
      { parserRevision: "roic-transcript-speakers-v1", documentKey: accession }
    );

    if (!result || result.error || result.wuExhausted || result.unconfigured || !result.documentComplete) {
      return false;
    }

    insertIngestedAccession(accession, ROIC_TRANSCRIPT_DOC_TYPE, transcript.symbol, result.indexed);
    audit("roic_transcript_ingested", {
      symbol: transcript.symbol,
      year: transcript.year,
      quarter: transcript.quarter,
      doc_id,
      accession,
      userId
    });
    logApiHealth({
      service: "roic",
      ok: true,
      errorText: `Ingested ${transcript.symbol} Q${transcript.quarter} ${transcript.year} transcript into RAG`,
      userId
    });

    try {
      const { generateAndStoreDocumentAbstract, tradeHighlightChunksFromText } = await import(
        "../rag/document-summarizer"
      );
      await generateAndStoreDocumentAbstract({
        ticker: transcript.symbol,
        accessionOrEventId: accession,
        sourceType: "earnings-summary",
        headline: `${transcript.symbol} earnings call highlights ${transcript.year} Q${transcript.quarter}`,
        chunks: tradeHighlightChunksFromText(transcript.content, {
          maxChunks: 8,
          formHint: "earnings",
          sections: speakerSections(transcript)
        }),
        publishedAt: published,
        acceptanceDatetime: observed
      });
    } catch (err) {
      console.warn(
        `[roic-transcripts] abstract failed for ${accession}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    return true;
  } catch (err) {
    console.error(`[roic-transcripts] failed to store RAG document for ${doc_id}:`, err);
    return false;
  }
}

function loadManifestRank(manifestPath: string = path.resolve("data/rag-universe-manifest.json")): Map<string, number> {
  const rank = new Map<string, number>();
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { issuers?: Array<{ ticker?: unknown; rank?: unknown }> };
    for (const issuer of parsed.issuers ?? []) {
      const ticker = typeof issuer.ticker === "string" ? normalizeSymbol(issuer.ticker) : "";
      const r = typeof issuer.rank === "number" ? issuer.rank : undefined;
      if (ticker && r !== undefined && !rank.has(ticker)) rank.set(ticker, r);
    }
  } catch {
    // Non-fatal tail-fill.
  }
  return rank;
}

/**
 * Holdings by value, then watchlists, technical watchlist, each user's policy
 * index universe, then the 1k-issuer RAG manifest.  A symbol appears once at
 * its best tier so the cursor fills what the desk actually trades first.
 */
export function rankRoicUniverseSymbols(options?: { symbols?: string[]; now?: number }): string[] {
  if (options?.symbols?.length) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of options.symbols) {
      const s = normalizeSymbol(raw);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  const now = options?.now ?? Date.now();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const s = normalizeSymbol(raw);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  try {
    const held = [...listRecentlyHeldSymbolValuesAllUsers(30, now).entries()]
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [symbol] of held) push(symbol);
  } catch {
    for (const s of listRecentlyHeldSymbolsAllUsers(30, now)) push(s);
  }

  for (const userId of listUsers()) {
    try {
      for (const item of listWatchlistSymbols(userId)) push(item.symbol);
    } catch {
      // ignore per-user watchlist errors
    }
  }

  try {
    for (const s of getTechnicalWatchlist()) push(s);
  } catch {
    // ignore
  }

  for (const userId of listUsers()) {
    try {
      for (const s of symbolsForPolicyUniverse(getPolicy(userId))) push(s);
    } catch {
      // ignore per-user policy errors
    }
  }

  const manifest = [...loadManifestRank().entries()].sort((a, b) => a[1] - b[1]);
  for (const [symbol] of manifest) push(symbol);

  return out;
}

/**
 * Demand-first then universe-wide ROIC transcript pass.  List-first so we
 * request only periods ROIC actually has.  Skip already-ingested accessions.
 * Cursor continues mid-universe across scheduler ticks instead of sleeping 24h.
 */
export async function refreshRoicTranscriptsIfDue(options?: {
  force?: boolean;
  now?: number;
  symbols?: string[];
  userId?: string;
}): Promise<RoicTranscriptRefreshResult> {
  const now = options?.now ?? Date.now();
  const enabled = roicTranscriptsEnabled(options?.userId);
  const base: RoicTranscriptRefreshResult = {
    attempted: 0,
    ingested: 0,
    skippedNoContent: 0,
    skippedAlreadyStored: 0,
    symbolsConsidered: 0,
    due: enabled && isRoicTranscriptRefreshDue(now),
    enabled,
    remaining: 0
  };
  if (!enabled) return base;
  if (!options?.force && !isRoicTranscriptRefreshDue(now)) return base;
  // Daily Pinecone write fuse is already spent: keep the cursor and skip the ROIC fetch
  // loop.  storeDocument would refuse each new transcript after opening no useful work.
  if (!hasPineconeWriteBudget(options?.userId ?? "local")) {
    return { ...base, due: true };
  }

  const nowIso = new Date(now).toISOString();
  let queue: string[];
  const existing = options?.force || options?.symbols?.length ? null : readRoicCursor();
  if (existing && existing.queue.length > 0) {
    queue = existing.queue;
  } else {
    queue = rankRoicUniverseSymbols({ symbols: options?.symbols, now });
  }

  base.symbolsConsidered = queue.length;
  const depth = quartersPerSymbol(options?.userId);
  const budget = maxTranscriptsPerRun(options?.userId);
  let remainingBudget = budget;

  while (queue.length > 0 && remainingBudget > 0) {
    const symbol = queue[0]!;
    let index: RoicCallIndexRow[] = [];
    try {
      remainingBudget -= 1;
      base.attempted += 1;
      index = await fetchRoicCallIndex(symbol, options?.userId);
    } catch {
      queue.shift();
      continue;
    }

    const periods = (index.length > 0
      ? index.map((row) => ({ year: row.year, quarter: row.quarter, date: row.date }))
      : recentFiscalPeriods(new Date(now), depth).map((p) => ({ ...p, date: undefined }))
    ).slice(0, depth);

    let symbolDone = true;
    for (const period of periods) {
      const accession = roicTranscriptAccession(symbol, period.year, period.quarter);
      if (hasIngestedAccession(accession, ROIC_TRANSCRIPT_DOC_TYPE)) {
        base.skippedAlreadyStored += 1;
        continue;
      }
      if (remainingBudget <= 0) {
        symbolDone = false;
        break;
      }
      remainingBudget -= 1;
      base.attempted += 1;
      try {
        const item = await fetchRoicTranscript(symbol, period.year, period.quarter, options?.userId);
        if (!item) {
          base.skippedNoContent += 1;
          continue;
        }
        if (!item.date && period.date) item.date = period.date;
        const ok = await ingestRoicTranscriptToRag(item, options?.userId);
        if (ok) base.ingested += 1;
        else base.skippedNoContent += 1;
      } catch {
        base.skippedNoContent += 1;
      }
    }

    if (symbolDone) queue.shift();
    else break;
  }

  writeRoicCursor(queue, nowIso);
  setInternalSetting(LAST_ATTEMPT_KEY, nowIso);
  if (queue.length === 0) {
    setInternalSetting(LAST_COMPLETE_KEY, nowIso);
  }
  base.remaining = queue.length;
  audit("roic_transcript_refresh", {
    attempted: base.attempted,
    ingested: base.ingested,
    skippedNoContent: base.skippedNoContent,
    skippedAlreadyStored: base.skippedAlreadyStored,
    symbolsConsidered: base.symbolsConsidered,
    remaining: base.remaining
  });
  return { ...base, due: true };
}
