// ROIC.ai earnings-call transcript ingestion -> shared RAG corpus.
//
// Full transcripts from ROIC.ai:
//   v3: GET /v3.0.0/earnings-calls/{NASDAQ:SYM}?fiscal_year=&fiscal_quarter=
//   v2 fallback: GET /v2/company/earnings-calls/latest/{SYM} (latest only)
// into the shared RAG vector store (doc_type "earnings-transcript", source "roic-earnings-transcript").
// Prefer ROIC over free EarningsCalls previews when the owner has a paid/entitled ROIC key.
//
// Scheduler: refreshRoicTranscriptsIfDue (wired from scheduler.ts). Opt-in = ROIC key present;
// kill-switch ROIC_TRANSCRIPTS_DISABLED=1. Quarters-per-symbol follow Connections plan tier
// (free=2, individual=6, …) unless ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL overrides.

import { fetchWithRetry } from "../data-providers";
import { audit } from "../db";
import {
  getUserApiKey,
  listUsers,
  listWatchlistSymbols,
  LOCAL_USER,
  resolveApiKeyWithSource
} from "../db-api-keys";
import { listRecentlyHeldSymbolsAllUsers } from "../db-fills";
import { logApiHealth } from "../db-health";
import { getInternalSetting, setInternalSetting } from "../db-settings";
import { normalizeSymbol } from "../money";
import { lookupRegisteredPlanTier, roicTranscriptQuartersForPlan } from "../provider-tier-plan";
import { storeDocument } from "../vector-db";

export const ROIC_TRANSCRIPT_DOC_TYPE = "earnings-transcript";
export const ROIC_TRANSCRIPT_SOURCE = "roic-earnings-transcript";

const ROIC_V3_BASE = "https://api.roic.ai/v3.0.0";
const ROIC_V2_BASE = "https://api.roic.ai/v2";
const LAST_ATTEMPT_KEY = "webSource:roicTranscripts:lastAttemptAt";
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_MAX_TRANSCRIPTS_PER_RUN = 12;

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

/** Effective quarters: env override wins, else Connections plan tier, else free-safe 2. */
export function quartersPerSymbol(userId?: string): number {
  const envRaw = process.env.ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return Math.max(1, Math.min(8, Math.floor(n)));
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
 * Earnings for calendar Q1 usually print in the following months — we walk
 * backward from the previous calendar quarter so we rarely request the current
 * unfinished period.
 */
export function recentFiscalPeriods(
  now: Date = new Date(),
  count: number = quartersPerSymbol()
): Array<{ year: number; quarter: number }> {
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

export function parseRoicTranscriptResponse(
  json: unknown,
  symbol: string,
  year: number,
  quarter: number
): RoicTranscriptItem | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const content = transcriptTextFromRoicPayload(obj.transcript ?? obj.content ?? obj.text ?? obj.body);
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
    content
  };
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

  // v3 period-specific retrieve (canonical).
  for (const identifier of roicV3Identifiers(normalized)) {
    const url =
      `${ROIC_V3_BASE}/earnings-calls/${encodeURIComponent(identifier)}` +
      `?fiscal_year=${year}&fiscal_quarter=${quarter}&format=json&apikey=${encodeURIComponent(keyInfo.key)}`;
    try {
      const res = await fetchWithRetry(url, {}, fetchOpts);
      if (!res || !res.ok) continue;
      const json = await res.json();
      const parsed = parseRoicTranscriptResponse(json, normalized, year, quarter);
      if (parsed) return parsed;
    } catch (err) {
      console.warn(
        `[roic-transcripts] v3 fetch failed for ${identifier} Q${quarter} ${year}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // v2 latest only — only use when the requested period is the most recent completed
  // (or when we just want any full text). Always try once as last resort for the first period.
  try {
    const latestUrl =
      `${ROIC_V2_BASE}/company/earnings-calls/latest/${encodeURIComponent(normalized)}` +
      `?apikey=${encodeURIComponent(keyInfo.key)}`;
    const res = await fetchWithRetry(latestUrl, {}, fetchOpts);
    if (res?.ok) {
      const json = await res.json();
      const parsed = parseRoicTranscriptResponse(json, normalized, year, quarter);
      // Accept latest only when it matches the requested period (or period fields missing).
      if (parsed) {
        const matchesPeriod =
          (parsed.year === year && parsed.quarter === quarter) ||
          (typeof (json as { year?: unknown }).year !== "number" &&
            typeof (json as { quarter?: unknown }).quarter !== "number");
        if (matchesPeriod) return parsed;
      }
    }
  } catch (err) {
    console.warn(
      `[roic-transcripts] v2 latest failed for ${normalized}:`,
      err instanceof Error ? err.message : err
    );
  }

  return null;
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
  const periods = recentFiscalPeriods(new Date(now), quartersPerSymbol(options?.userId));
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
