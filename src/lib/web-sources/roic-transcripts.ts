// ROIC.ai earnings-call transcript ingestion -> shared RAG corpus.
//
// Ingests full earnings call transcripts from ROIC.ai (/v2/transcript/{symbol}/{year}/{quarter})
// into the shared RAG vector store (doc_type "earnings-transcript", source "roic-earnings-transcript").
// Leverages the user's high-capacity ROIC.ai individual subscription to bypass free-tier rate limits.
//
// Scheduler: refreshRoicTranscriptsIfDue (wired from scheduler.ts). Opt-in = ROIC key present;
// kill-switch ROIC_TRANSCRIPTS_DISABLED=1. Without the scheduler wire, helpers alone never
// persisted transcripts (root cause of "no ROIC transcripts saved" as of 2026-08-05).

import { fetchWithRetry } from "../data-providers";
import { audit } from "../db";
import { listUsers, listWatchlistSymbols, resolveApiKeyWithSource } from "../db-api-keys";
import { listRecentlyHeldSymbolsAllUsers } from "../db-fills";
import { logApiHealth } from "../db-health";
import { getInternalSetting, setInternalSetting } from "../db-settings";
import { normalizeSymbol } from "../money";
import { storeDocument } from "../vector-db";

export const ROIC_TRANSCRIPT_DOC_TYPE = "earnings-transcript";
export const ROIC_TRANSCRIPT_SOURCE = "roic-earnings-transcript";

const ROIC_BASE = "https://api.roic.ai/v2";
const LAST_ATTEMPT_KEY = "webSource:roicTranscripts:lastAttemptAt";
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_MAX_TRANSCRIPTS_PER_RUN = 12;
const DEFAULT_QUARTERS_PER_SYMBOL = 2;

function flagOn(value: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? "").trim());
}

/** Owner kill-switch — halts ROIC transcript fetch without deleting the key. */
export function roicTranscriptsKillSwitchOn(): boolean {
  return flagOn(process.env.ROIC_TRANSCRIPTS_DISABLED);
}

/** Key present (user or env) and kill-switch off. */
export function roicTranscriptsEnabled(userId?: string): boolean {
  if (roicTranscriptsKillSwitchOn()) return false;
  return Boolean(resolveApiKeyWithSource("roic", userId).key);
}

function ttlMs(): number {
  const h = Number(process.env.ROIC_TRANSCRIPTS_TTL_HOURS ?? DEFAULT_TTL_HOURS);
  return Math.max(1, Number.isFinite(h) ? h : DEFAULT_TTL_HOURS) * 3_600_000;
}

function maxTranscriptsPerRun(): number {
  const n = Number(process.env.ROIC_TRANSCRIPTS_MAX_PER_RUN ?? DEFAULT_MAX_TRANSCRIPTS_PER_RUN);
  return Math.max(1, Math.min(50, Number.isFinite(n) ? n : DEFAULT_MAX_TRANSCRIPTS_PER_RUN));
}

function quartersPerSymbol(): number {
  const n = Number(process.env.ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL ?? DEFAULT_QUARTERS_PER_SYMBOL);
  return Math.max(1, Math.min(8, Number.isFinite(n) ? n : DEFAULT_QUARTERS_PER_SYMBOL));
}

/**
 * Most recent completed fiscal quarters to try (calendar approximation).
 * Earnings for calendar Q1 usually print in the following months — we walk
 * backward from the previous calendar quarter so we rarely request the current
 * unfinished period.
 */
export function recentFiscalPeriods(now: Date = new Date(), count: number = quartersPerSymbol()): Array<{ year: number; quarter: number }> {
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3); // 0..3 for current incomplete quarter index
  // Start at the previous completed quarter (if month is Jan-Mar, previous is Q4 prior year).
  if (quarter === 0) {
    year -= 1;
    quarter = 4;
  }
  // quarter is now 1..4 for the last completed calendar quarter
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

export function isRoicTranscriptRefreshDue(now: number = Date.now()): boolean {
  if (!roicTranscriptsEnabled()) return false;
  const last = getInternalSetting<unknown>(LAST_ATTEMPT_KEY);
  if (typeof last !== "string" || !last) return true;
  const ts = Date.parse(last);
  if (!Number.isFinite(ts)) return true;
  return now - ts >= ttlMs();
}

export interface RoicTranscriptRefreshResult {
  attempted: number;
  ingested: number;
  skippedNoContent: number;
  symbolsConsidered: number;
  due: boolean;
  enabled: boolean;
}

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

/**
 * Demand-first ROIC transcript pass: holdings → watchlist, last N fiscal quarters per symbol,
 * hard cap per run. Self-guarded by isRoicTranscriptRefreshDue unless force.
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
    symbolsConsidered: 0,
    due: enabled && isRoicTranscriptRefreshDue(now),
    enabled
  };
  if (!enabled) return base;
  if (!options?.force && !isRoicTranscriptRefreshDue(now)) return base;

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const s = normalizeSymbol(raw);
    if (!s || seen.has(s)) return;
    seen.add(s);
    ordered.push(s);
  };

  if (options?.symbols?.length) {
    for (const s of options.symbols) push(s);
  } else {
    for (const s of listRecentlyHeldSymbolsAllUsers(30, now)) push(s);
    for (const userId of listUsers()) {
      try {
        for (const item of listWatchlistSymbols(userId)) push(item.symbol);
      } catch {
        // ignore per-user watchlist errors
      }
    }
  }

  base.symbolsConsidered = ordered.length;
  const periods = recentFiscalPeriods(new Date(now), quartersPerSymbol());
  const budget = maxTranscriptsPerRun();
  let remaining = budget;

  for (const symbol of ordered) {
    if (remaining <= 0) break;
    for (const { year, quarter } of periods) {
      if (remaining <= 0) break;
      remaining -= 1;
      base.attempted += 1;
      try {
        const item = await fetchRoicTranscript(symbol, year, quarter, options?.userId);
        if (!item) {
          base.skippedNoContent += 1;
          continue;
        }
        const ok = await ingestRoicTranscriptToRag(item, options?.userId);
        if (ok) base.ingested += 1;
        else base.skippedNoContent += 1;
      } catch {
        base.skippedNoContent += 1;
      }
    }
  }

  setInternalSetting(LAST_ATTEMPT_KEY, new Date(now).toISOString());
  audit("roic_transcript_refresh", {
    attempted: base.attempted,
    ingested: base.ingested,
    skippedNoContent: base.skippedNoContent,
    symbolsConsidered: base.symbolsConsidered
  });
  return { ...base, due: true };
}
