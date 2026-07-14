// FMP earnings-call transcript ingestion -> shared RAG corpus.
//
// Safety invariants:
//  - Default OFF until the operator confirms FMP endpoint access and transcript storage/display rights.
//  - Uses only the current stable transcript-dates + transcript-body endpoints.
//  - Authentication is an HTTP header. API keys, response bodies, and request URLs are never logged.
//  - Every actual FMP request crosses fetchWithRetry; HTTP 200 outcomes are metered only after
//    bounded JSON validation, so malformed provider bodies cannot create false-green telemetry.
//  - A transcript's call date is event metadata, NOT an availability timestamp. Point-in-time retrieval
//    uses the first time this app observed non-empty transcript content.
//  - Empty/transient responses never enter the ingestion ledger and therefore remain retryable.

import crypto from "crypto";
import { CircuitOpenError } from "../api-circuit-breaker";
import { fetchWithRetry, apiKeyFingerprint } from "../data-providers";
import { logApiHealth } from "../db-health";
import { resolveProviderQuota, withProviderLimit } from "../provider-rate-limit";
import {
  audit,
  cancelUndispatchedProviderReservation,
  deleteInternalSetting,
  getFmpTranscriptVersion,
  getDb,
  getInternalSetting,
  ingestedAccessionCountForDocType,
  markProviderDispatchStarted,
  observeFmpTranscriptVersion,
  reserveProviderDispatch,
  resolveApiKeyWithSource,
  setFmpTranscriptVersionState,
  settleProviderDispatch,
  setInternalSetting
} from "../db";
import { normalizeSymbol } from "../money";
import {
  assertOperationLeaseOwnership,
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseClaim,
  type OperationLeaseAware
} from "../operation-lease";

export const FMP_TRANSCRIPT_DOC_TYPE = "earnings-transcript";
export const FMP_TRANSCRIPT_SOURCE = "fmp-earnings-transcript";

const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";
const LAST_ATTEMPT_KEY = "webSource:fmpTranscripts:lastAttemptAt";
const NEXT_ATTEMPT_KEY = "webSource:fmpTranscripts:nextAttemptAt";
const CURSOR_KEY = "webSource:fmpTranscripts:cursor";
const CAPABILITY_KEY = "webSource:fmpTranscripts:capability";
const BODY_RETRY_ACCESSION_KEY = "webSource:fmpTranscripts:bodyRetryAccession";
const EMBED_RETRY_ACCESSION_KEY = "webSource:fmpTranscripts:embedRetryAccession";
const OBSERVATION_PREFIX = "webSource:fmpTranscripts:observation:";
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_RETRY_MINUTES = 60;
const DEFAULT_NOT_ENTITLED_RETRY_HOURS = 24;
const DEFAULT_REQUESTS_PER_RUN = 12;
const DEFAULT_TRANSCRIPTS_PER_SYMBOL = 2;
const DEFAULT_HTTP_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 600;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DATES_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TRANSCRIPT_RESPONSE_BYTES = 8_000_000;
const MIN_TRANSCRIPT_CHARS = 100;
const MAX_DATES_ROWS = 5_000;
const MAX_BODY_ROWS = 20;
const OVERSIZED_RESPONSE_ERROR = "HTTP 200 response exceeded the configured byte limit.";
const INVALID_JSON_RESPONSE_ERROR = "HTTP 200 response body was invalid or incomplete JSON/UTF-8.";
const INVALID_PAYLOAD_RESPONSE_ERROR = "HTTP 200 response body did not match the expected FMP endpoint schema.";

export type FmpTranscriptCapability =
  | "disabled"
  | "unknown"
  | "available"
  | "endpoint_not_entitled";

export interface FmpTranscriptCapabilityObservation {
  status: Exclude<FmpTranscriptCapability, "disabled" | "unknown">;
  checkedAt: string;
  httpStatus?: number;
}

export interface FmpTranscriptStatus {
  featureEnabled: boolean;
  storageRightsConfirmed: boolean;
  enabled: boolean;
  due: boolean;
  capability: FmpTranscriptCapability;
  lastCapability?: FmpTranscriptCapabilityObservation;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  ingestedCount: number;
}

export interface FmpTranscriptRef {
  symbol: string;
  year: number;
  quarter: number;
  /** The earnings-call date reported by FMP. This is not an availability timestamp. */
  callDate?: string;
}

export interface FmpTranscriptBody extends FmpTranscriptRef {
  content: string;
}

export interface FmpTranscriptObservation {
  accession: string;
  symbol: string;
  year: number;
  quarter: number;
  /** First time the transcript-period row was returned by the dates endpoint. */
  discoveredAt: string;
  /** First time this app actually received non-empty transcript content. PIT anchor for RAG. */
  firstContentSeenAt?: string;
  /** Provider-reported call date. Event metadata only. */
  callDate?: string;
}

export interface RefreshFmpTranscriptsResult {
  enabled: boolean;
  capability: FmpTranscriptCapability;
  disabledReason?: "feature_off" | "storage_rights_unconfirmed";
  requests: number;
  symbolsAttempted: number;
  transcriptsAttempted: number;
  ingested: number;
  skippedExisting: number;
  retryableEmpty: number;
  deferredForRequestBudget: number;
  deferredForProviderQuota: number;
  deferredForEmbedBudget: number;
  errors: string[];
}

export interface RefreshFmpTranscriptOptions {
  /** Bypass cadence only. The default-off feature gate still applies. */
  force?: boolean;
  /** Explicit run cap for bounded admin/tests; normal scheduler calls use the env/default cap. */
  maxRequests?: number;
  userId?: string;
}

interface RequestBudget {
  remaining: number;
  used: number;
}

type FmpRequestFailureKind =
  | "request_budget"
  | "provider_quota"
  | "endpoint_not_entitled"
  | "response_too_large"
  | "transient"
  | "permanent";

type FmpRequestResult =
  | { ok: true; payload: unknown; receivedAt: string }
  | { ok: false; kind: FmpRequestFailureKind; status?: number; circuitOpen?: boolean };

class ResponseTooLargeError extends Error {
  constructor() {
    super("Provider response exceeded the configured byte limit.");
    this.name = "ResponseTooLargeError";
  }
}

class InvalidEndpointPayloadError extends Error {
  constructor() {
    super("Provider response did not match the expected endpoint schema.");
    this.name = "InvalidEndpointPayloadError";
  }
}

type FmpEndpointPayloadKind = "dates" | "body";

function finiteNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string" || !raw.trim() || !/^-?\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(raw: unknown, fallback: number): number {
  const parsed = finiteNumber(raw);
  return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

function positiveInt(raw: unknown, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Math.floor(positiveNumber(raw, fallback))));
}

function nonNegativeInt(raw: unknown, fallback: number, max: number): number {
  const parsed = finiteNumber(raw);
  return parsed !== undefined && parsed >= 0
    ? Math.min(max, Math.floor(parsed))
    : fallback;
}

function ttlMs(): number {
  return positiveNumber(process.env.FMP_TRANSCRIPT_TTL_HOURS, DEFAULT_TTL_HOURS) * 60 * 60_000;
}

function retryMs(): number {
  return positiveNumber(process.env.FMP_TRANSCRIPT_RETRY_MINUTES, DEFAULT_RETRY_MINUTES) * 60_000;
}

function notEntitledRetryMs(): number {
  return positiveNumber(
    process.env.FMP_TRANSCRIPT_NOT_ENTITLED_RETRY_HOURS,
    DEFAULT_NOT_ENTITLED_RETRY_HOURS
  ) * 60 * 60_000;
}

function maxRequestsPerRun(): number {
  return nonNegativeInt(process.env.FMP_TRANSCRIPT_MAX_REQUESTS_PER_RUN, DEFAULT_REQUESTS_PER_RUN, 500);
}

function maxTranscriptsPerSymbol(): number {
  return positiveInt(process.env.FMP_TRANSCRIPT_MAX_PER_SYMBOL, DEFAULT_TRANSCRIPTS_PER_SYMBOL, 8);
}

function httpRetries(): number {
  return nonNegativeInt(process.env.FMP_TRANSCRIPT_HTTP_RETRIES, DEFAULT_HTTP_RETRIES, 3);
}

function retryDelayMs(): number {
  const value = finiteNumber(process.env.FMP_TRANSCRIPT_RETRY_DELAY_MS);
  return value !== undefined && value >= 0 ? Math.min(10_000, value) : DEFAULT_RETRY_DELAY_MS;
}

function timeoutMs(): number {
  return positiveInt(process.env.FMP_TRANSCRIPT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 120_000);
}

function datesResponseBytes(): number {
  return positiveInt(
    process.env.FMP_TRANSCRIPT_DATES_MAX_RESPONSE_BYTES,
    DEFAULT_DATES_RESPONSE_BYTES,
    10_000_000
  );
}

function transcriptResponseBytes(): number {
  return positiveInt(
    process.env.FMP_TRANSCRIPT_BODY_MAX_RESPONSE_BYTES,
    DEFAULT_TRANSCRIPT_RESPONSE_BYTES,
    25_000_000
  );
}

function flagOn(raw: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

export function fmpTranscriptStorageRightsConfirmed(
  raw: string | undefined = process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED
): boolean {
  return flagOn(raw);
}

/** Two explicit opt-ins: endpoint use and confirmed rights to persist transcript content. */
export function fmpTranscriptsEnabled(
  featureRaw: string | undefined = process.env.WEB_SOURCE_FMP_TRANSCRIPTS,
  rightsRaw: string | undefined = process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED
): boolean {
  return flagOn(featureRaw) && fmpTranscriptStorageRightsConfirmed(rightsRaw);
}

function disabledReason(): RefreshFmpTranscriptsResult["disabledReason"] {
  if (!flagOn(process.env.WEB_SOURCE_FMP_TRANSCRIPTS)) return "feature_off";
  if (!flagOn(process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED)) return "storage_rights_unconfirmed";
  return undefined;
}

/** Independent producer cadence. Disabled means never due, including when no marker exists. */
export function isFmpTranscriptRefreshDue(now: number = Date.now()): boolean {
  if (!fmpTranscriptsEnabled()) return false;
  const next = getInternalSetting<string>(NEXT_ATTEMPT_KEY);
  if (!next) return true;
  const nextMs = Date.parse(next);
  return !Number.isFinite(nextMs) || now >= nextMs;
}

/** Ticker-inclusive durable identifier: two companies' same fiscal period can never collide. */
export function transcriptAccession(symbol: string, year: number, quarter: number): string {
  const normalized = validSymbol(symbol);
  if (!normalized) throw new Error("Invalid transcript symbol.");
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error("Invalid transcript year.");
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new Error("Invalid transcript quarter.");
  return `FMP-EARNINGS-TRANSCRIPT:${normalized}:${year}:Q${quarter}`;
}

export function transcriptContentVersion(content: string): { contentSha256: string; versionIdSuffix: string } {
  const contentSha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return { contentSha256, versionIdSuffix: `VERSION:${contentSha256}` };
}

/** Start immediately after the prior attempted symbol, wrapping once, without sorting away demand order. */
export function rotateSymbolsAfterCursor(symbols: string[], cursor: string | undefined): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of dataArray(symbols, 100_000)) {
    const symbol = validSymbol(raw);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }
  const normalizedCursor = cursor ? validSymbol(cursor) : "";
  const index = normalizedCursor ? unique.indexOf(normalizedCursor) : -1;
  if (index < 0 || index === unique.length - 1) return index < 0 ? unique : [...unique];
  return [...unique.slice(index + 1), ...unique.slice(0, index + 1)];
}

function validSymbol(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = normalizeSymbol(raw);
  return /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(value) ? value : "";
}

function validYear(raw: unknown): number | undefined {
  const value = finiteNumber(raw);
  const upper = new Date().getUTCFullYear() + 1;
  return value !== undefined && Number.isInteger(value) && value >= 1990 && value <= upper
    ? value
    : undefined;
}

function validQuarter(raw: unknown): number | undefined {
  if (typeof raw === "string") {
    const period = /^Q([1-4])$/i.exec(raw.trim());
    if (period) return Number(period[1]);
  }
  const value = finiteNumber(raw);
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 4
    ? value
    : undefined;
}

function validDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  // Provider values without a timezone are retained only at day precision. They are event metadata,
  // never the point-in-time availability gate, so inventing a local/UTC clock time would add no value.
  const dateOnly = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(value)?.[1];
  if (dateOnly && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const parsedDay = Date.parse(`${dateOnly}T00:00:00.000Z`);
    const normalized = Number.isFinite(parsedDay) ? new Date(parsedDay).toISOString() : undefined;
    return normalized?.startsWith(dateOnly) ? normalized : undefined;
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** Snapshot JSON-shaped data without invoking caller-controlled getters, iterators, or coercions. */
function dataRecord(raw: unknown): Record<string, unknown> | undefined {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const value = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      value[key] = descriptor.value;
    }
    return value;
  } catch {
    // Direct parser callers may hand us a hostile Proxy even though JSON.parse cannot create one.
    return undefined;
  }
}

function dataArray(raw: unknown, maxRows: number): unknown[] {
  try {
    if (!Array.isArray(raw)) return [];
    const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxRows) return [];
    const rows: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!descriptor || !("value" in descriptor)) return [];
      rows.push(descriptor.value);
    }
    return rows;
  } catch {
    // JSON.parse cannot create a Proxy, but exported parser callers may still pass one.
    return [];
  }
}

function payloadRows(payload: unknown, maxRows: number): unknown[] {
  try {
    if (Array.isArray(payload)) return dataArray(payload, maxRows);
  } catch {
    return [];
  }
  return dataArray(dataRecord(payload)?.data, maxRows);
}

function hasEmbeddedProviderError(record: Record<string, unknown>, rejectMessage: boolean): boolean {
  for (const [rawKey, value] of Object.entries(record)) {
    const key = rawKey.toLowerCase().replace(/[\s_-]+/g, "");
    if (key === "error" || key === "errors" || key === "errormessage" || key === "errorcode") {
      return true;
    }
    if (rejectMessage && key === "message" && typeof value === "string" && value.trim().length > 0) {
      return true;
    }
    if (key === "success" && value === false) return true;
    if ((key === "status" || key === "statuscode") && (finiteNumber(value) ?? 0) >= 400) return true;
  }
  return false;
}

function endpointPayloadRows(payload: unknown, maxRows: number): unknown[] | undefined {
  try {
    let rawRows: unknown;
    if (Array.isArray(payload)) rawRows = payload;
    else {
      const record = dataRecord(payload);
      if (!record || !Object.hasOwn(record, "data")) return undefined;
      // FMP can report quota/auth/provider failures inside an HTTP 200 JSON envelope. A `data`
      // property must never mask those markers and turn the attempt green.
      if (hasEmbeddedProviderError(record, true)) return undefined;
      rawRows = record.data;
    }
    if (!Array.isArray(rawRows)) return undefined;
    const length = Object.getOwnPropertyDescriptor(rawRows, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxRows) return undefined;
    const rows: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(rawRows, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      rows.push(descriptor.value);
    }
    return rows;
  } catch {
    return undefined;
  }
}

/** Validate the endpoint envelope and stable row schema before an HTTP 200 becomes green telemetry. */
export function isValidFmpEndpointPayload(payload: unknown, kind: FmpEndpointPayloadKind): boolean {
  const rows = endpointPayloadRows(payload, kind === "dates" ? MAX_DATES_ROWS : MAX_BODY_ROWS);
  if (!rows) return false;
  return rows.every((raw) => {
    const row = dataRecord(raw);
    if (!row) return false;
    if (hasEmbeddedProviderError(row, false)) return false;
    const symbolValue = row.symbol;
    const symbolValid = symbolValue === undefined || Boolean(validSymbol(symbolValue));
    const yearValid = validYear(row.year ?? row.fiscalYear) !== undefined;
    const quarterValid = validQuarter(row.quarter ?? row.fiscalQuarter ?? row.period) !== undefined;
    if (!symbolValid || !yearValid || !quarterValid) return false;
    if (kind === "body") {
      return Boolean(validSymbol(symbolValue)) && typeof row.content === "string";
    }
    // A transcript-body row is not a valid dates response merely because it also carries a period.
    return !Object.hasOwn(row, "content") && (row.date === undefined || typeof row.date === "string");
  });
}

/** Parse the current stable transcript-dates response; malformed rows are ignored, not invented. */
export function parseFmpTranscriptDates(payload: unknown, requestedSymbol: string): FmpTranscriptRef[] {
  const fallbackSymbol = validSymbol(requestedSymbol);
  if (!fallbackSymbol) return [];
  const byPeriod = new Map<string, FmpTranscriptRef>();
  for (const raw of payloadRows(payload, MAX_DATES_ROWS)) {
    const row = dataRecord(raw);
    if (!row) continue;
    const symbol = validSymbol(row.symbol ?? fallbackSymbol);
    const year = validYear(row.year ?? row.fiscalYear);
    const quarter = validQuarter(row.quarter ?? row.fiscalQuarter ?? row.period);
    if (!symbol || symbol !== fallbackSymbol || year === undefined || quarter === undefined) continue;
    const ref: FmpTranscriptRef = {
      symbol,
      year,
      quarter,
      ...(validDate(row.date) ? { callDate: validDate(row.date) } : {})
    };
    byPeriod.set(`${symbol}:${year}:Q${quarter}`, ref);
  }
  return [...byPeriod.values()].sort((a, b) => {
    const byDate = Date.parse(b.callDate ?? "") - Date.parse(a.callDate ?? "");
    if (Number.isFinite(byDate) && byDate !== 0) return byDate;
    return b.year - a.year || b.quarter - a.quarter;
  });
}

/** Parse the current stable transcript body response and require useful non-empty content. */
export function parseFmpTranscriptBody(payload: unknown, expected: FmpTranscriptRef): FmpTranscriptBody | undefined {
  for (const raw of payloadRows(payload, MAX_BODY_ROWS)) {
    const row = dataRecord(raw);
    if (!row) continue;
    const symbol = validSymbol(row.symbol);
    const year = validYear(row.year);
    const quarter = validQuarter(row.quarter ?? row.period);
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (
      symbol !== expected.symbol ||
      year !== expected.year ||
      quarter !== expected.quarter ||
      content.length < MIN_TRANSCRIPT_CHARS
    ) continue;
    return {
      symbol,
      year,
      quarter,
      content,
      ...(validDate(row.date) ?? expected.callDate ? { callDate: validDate(row.date) ?? expected.callDate } : {})
    };
  }
  return undefined;
}

function observationKey(accession: string): string {
  return `${OBSERVATION_PREFIX}${accession}`;
}

export function getFmpTranscriptObservation(accession: string): FmpTranscriptObservation | undefined {
  const value = dataRecord(getInternalSetting<unknown>(observationKey(accession)));
  if (!value || value.accession !== accession) return undefined;
  const symbol = validSymbol(value.symbol);
  const year = validYear(value.year);
  const quarter = validQuarter(value.quarter);
  const discoveredAt = validDate(value.discoveredAt);
  const firstContentSeenAt = value.firstContentSeenAt === undefined
    ? undefined
    : validDate(value.firstContentSeenAt);
  const callDate = value.callDate === undefined ? undefined : validDate(value.callDate);
  if (!symbol || year === undefined || quarter === undefined || !discoveredAt) return undefined;
  if (value.firstContentSeenAt !== undefined && !firstContentSeenAt) return undefined;
  if (value.callDate !== undefined && !callDate) return undefined;
  return {
    accession,
    symbol,
    year,
    quarter,
    discoveredAt,
    ...(firstContentSeenAt ? { firstContentSeenAt } : {}),
    ...(callDate ? { callDate } : {})
  };
}

function observeReference(ref: FmpTranscriptRef, observedAt: string): FmpTranscriptObservation {
  const accession = transcriptAccession(ref.symbol, ref.year, ref.quarter);
  const current = getFmpTranscriptObservation(accession);
  const next: FmpTranscriptObservation = {
    accession,
    symbol: ref.symbol,
    year: ref.year,
    quarter: ref.quarter,
    discoveredAt: current?.discoveredAt ?? observedAt,
    ...(current?.firstContentSeenAt ? { firstContentSeenAt: current.firstContentSeenAt } : {}),
    ...(ref.callDate ?? current?.callDate ? { callDate: ref.callDate ?? current?.callDate } : {})
  };
  setInternalSetting(observationKey(accession), next);
  return next;
}

function observeContent(ref: FmpTranscriptRef, observedAt: string): FmpTranscriptObservation {
  const current = observeReference(ref, observedAt);
  if (current.firstContentSeenAt) return current;
  const next = { ...current, firstContentSeenAt: observedAt };
  setInternalSetting(observationKey(current.accession), next);
  return next;
}

function endpoint(path: "earning-call-transcript-dates" | "earning-call-transcript", params: Record<string, string | number>): string {
  const url = new URL(`${FMP_STABLE_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return retryDelayMs();
  const seconds = finiteNumber(raw);
  if (seconds !== undefined && seconds >= 0) return Math.min(60_000, seconds * 1_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(60_000, Math.max(0, at - Date.now())) : retryDelayMs();
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = finiteNumber(response.headers.get("content-length"));
  if (declared !== undefined && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // The byte limit is authoritative even if this transport cannot cancel its stream cleanly.
    }
    throw new ResponseTooLargeError();
  }
  if (!response.body) throw new SyntaxError("Provider response body was empty.");

  const reader = response.body.getReader();
  // Replacement decoding would silently turn corrupt source bytes into U+FFFD and could still
  // produce syntactically valid JSON. Fatal decoding makes transport corruption a red attempt.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text);
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status is already authoritative. A transport-specific cancel failure must not mask it.
  }
}

async function retryPause(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfOperationLeaseCancelled(signal);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation lease ownership was lost."));
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function requestFmpJson(
  url: string,
  apiKey: string,
  keySource: string,
  userId: string,
  budget: RequestBudget,
  retries: number,
  maxResponseBytes: number,
  payloadKind: FmpEndpointPayloadKind,
  claim: OperationLeaseClaim,
  leaseSignal: AbortSignal
): Promise<FmpRequestResult> {
  const credential = apiKeyFingerprint(apiKey);
  for (let retry = 0; retry <= retries; retry++) {
    throwIfOperationLeaseCancelled(leaseSignal);
    assertOperationLeaseOwnership(claim);
    if (budget.remaining <= 0) return { ok: false, kind: "request_budget" };
    const reservation = reserveProviderDispatch({
      provider: "fmp",
      operation: `earnings-transcript-${payloadKind}`,
      credentialRef: credential,
      userId,
      units: 1,
      // FMP subscription access is flat-plan rather than per-call in this integration. A zero
      // variable-cost fuse is therefore exact; the durable request windows and per-run cap bind.
      estimatedCostUsd: 0,
      maxEstimatedCostUsdPer24h: 0,
      windows: (resolveProviderQuota("fmp") ?? []).map((window) => ({
        maxUnits: window.maxRequests,
        windowMs: window.windowMs
      }))
    });
    if (!reservation.admitted) return { ok: false, kind: "provider_quota" };
    const attemptId = reservation.attemptId;
    let attemptDispatched = false;
    let attemptSettled = false;

    budget.remaining -= 1;
    budget.used += 1;
    let response: Response;
    let attemptStartedAt = Date.now();
    try {
      response = await withProviderLimit("fmp", () => {
        attemptStartedAt = Date.now();
        return fetchWithRetry(
          url,
          {
            method: "GET",
            cache: "no-store",
            headers: { accept: "application/json", apikey: apiKey },
            signal: AbortSignal.any([leaseSignal, AbortSignal.timeout(timeoutMs())])
          },
          {
            service: "fmp",
            healthService: "fmp-transcripts",
            keySource,
            userId,
            apiKey,
            retries: 0,
            guard: {
              assertActive: () => assertOperationLeaseOwnership(claim),
              signal: leaseSignal
            },
            // HTTP 200 is not success until the bounded JSON body validates. The caller records one
            // health and usage outcome below. HTTP failures and transport errors stay wrapper-owned.
            deferSuccessLog: true,
            deferSuccessUsage: true,
            durableAttempt: {
              onDispatch: () => {
                markProviderDispatchStarted(attemptId);
                attemptDispatched = true;
              },
              onResponse: (received) => {
                if (!received.ok && !attemptSettled) {
                  settleProviderDispatch(attemptId, "failed", { outcomeCode: `http-${received.status}` });
                  attemptSettled = true;
                }
              },
              onTransportError: (error) => {
                if (!attemptSettled) {
                  settleProviderDispatch(attemptId, "failed", {
                    outcomeCode: error instanceof Error ? error.name : "transport-error"
                  });
                  attemptSettled = true;
                }
              }
            },
            // Usage remains attributable to FMP, while transcript failures have an isolated health/
            // circuit lane. HTTP 402 is durable entitlement state, not a transient health failure.
            suppressHealthStatuses: [402]
          }
        );
      });
    } catch (error) {
      if (attemptDispatched && !attemptSettled) {
        // A successful HTTP response whose body could not be classified before lease loss remains
        // explicitly unknown; it must never disappear or be guessed successful.
        settleProviderDispatch(attemptId, "unknown", { outcomeCode: "response-outcome-unclassified" });
        attemptSettled = true;
      }
      throwIfOperationLeaseCancelled(leaseSignal);
      assertOperationLeaseOwnership(claim);
      if (error instanceof CircuitOpenError) {
        // No upstream request left the process, so release the durable reservation.
        cancelUndispatchedProviderReservation(attemptId, "circuit-open");
        budget.remaining += 1;
        budget.used -= 1;
        return { ok: false, kind: "transient", circuitOpen: true };
      }
      if (retry < retries && budget.remaining > 0) {
        await retryPause(retryDelayMs(), leaseSignal);
        continue;
      }
      return { ok: false, kind: "transient" };
    }

    throwIfOperationLeaseCancelled(leaseSignal);
    assertOperationLeaseOwnership(claim);
    if (!response.ok) {
      const kind: FmpRequestFailureKind = response.status === 402
        ? "endpoint_not_entitled"
        : isTransientStatus(response.status)
          ? "transient"
          : "permanent";
      const delayMs = retryAfterMs(response);
      await discardResponseBody(response);
      // Response-body cancellation is itself async. A successor may acquire the durable lease while
      // a terminal body is being discarded, so re-prove ownership before returning a result that the
      // caller can turn into cursor/capability/settings writes.
      throwIfOperationLeaseCancelled(leaseSignal);
      assertOperationLeaseOwnership(claim);
      if (kind === "transient" && retry < retries && budget.remaining > 0) {
        await retryPause(delayMs, leaseSignal);
        continue;
      }
      // Deliberately do not read/log the provider response body.
      return { ok: false, kind, status: response.status };
    }

    try {
      const payload = await readBoundedJson(response, maxResponseBytes);
      if (!isValidFmpEndpointPayload(payload, payloadKind)) throw new InvalidEndpointPayloadError();
      if (!attemptSettled) {
        settleProviderDispatch(attemptId, "succeeded", { outcomeCode: "validated-http-200" });
        attemptSettled = true;
      }
      throwIfOperationLeaseCancelled(leaseSignal);
      assertOperationLeaseOwnership(claim);
      logApiHealth({
        service: "fmp-transcripts",
        ok: true,
        latencyMs: Date.now() - attemptStartedAt,
        keySource,
        userId
      });
      return { ok: true, payload, receivedAt: new Date(Date.now()).toISOString() };
    } catch (error) {
      if (!attemptSettled) {
        settleProviderDispatch(attemptId, "failed", {
          outcomeCode: error instanceof ResponseTooLargeError
            ? "response-too-large"
            : error instanceof InvalidEndpointPayloadError
              ? "invalid-payload"
              : "invalid-json"
        });
        attemptSettled = true;
      }
      throwIfOperationLeaseCancelled(leaseSignal);
      assertOperationLeaseOwnership(claim);
      const responseTooLarge = error instanceof ResponseTooLargeError;
      const invalidPayload = error instanceof InvalidEndpointPayloadError;
      logApiHealth({
        service: "fmp-transcripts",
        ok: false,
        latencyMs: Date.now() - attemptStartedAt,
        errorText: responseTooLarge
          ? OVERSIZED_RESPONSE_ERROR
          : invalidPayload
            ? INVALID_PAYLOAD_RESPONSE_ERROR
            : INVALID_JSON_RESPONSE_ERROR,
        keySource,
        userId
      });
      if (responseTooLarge) return { ok: false, kind: "response_too_large" };
      if (retry < retries && budget.remaining > 0) {
        await retryPause(retryDelayMs(), leaseSignal);
        continue;
      }
      return { ok: false, kind: "transient" };
    }
  }
  return { ok: false, kind: "transient" };
}

function recordIngestedTranscript(accession: string, ticker: string, chunkCount: number, indexedAt: string): void {
  // This producer is not an SEC filing, so write only the generic ingestion ledger and do not
  // synthesize a misleading sec_filings row through insertIngestedAccession().
  getDb()
    .prepare(
      `INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(accession, doc_type) DO UPDATE SET
         ticker = excluded.ticker,
         indexed_at = excluded.indexed_at,
         chunk_count = excluded.chunk_count`
    )
    .run(accession, FMP_TRANSCRIPT_DOC_TYPE, ticker, indexedAt, chunkCount);
}

export function getFmpTranscriptCapability(): FmpTranscriptCapabilityObservation | undefined {
  const value = dataRecord(getInternalSetting<unknown>(CAPABILITY_KEY));
  const status = value?.status;
  const checkedAt = validDate(value?.checkedAt);
  const httpStatus = value?.httpStatus;
  if ((status !== "available" && status !== "endpoint_not_entitled") || !checkedAt) return undefined;
  if (httpStatus !== undefined && (
    typeof httpStatus !== "number" ||
    !Number.isInteger(httpStatus) ||
    httpStatus < 100 ||
    httpStatus > 599
  )) {
    return undefined;
  }
  return {
    status,
    checkedAt,
    ...(typeof httpStatus === "number" ? { httpStatus } : {})
  };
}

export function getFmpTranscriptStatus(now: number = Date.now()): FmpTranscriptStatus {
  const featureEnabled = flagOn(process.env.WEB_SOURCE_FMP_TRANSCRIPTS);
  const storageRightsConfirmed = fmpTranscriptStorageRightsConfirmed();
  const enabled = featureEnabled && storageRightsConfirmed;
  const lastCapability = getFmpTranscriptCapability();
  const lastAttemptAt = validDate(getInternalSetting<string>(LAST_ATTEMPT_KEY));
  const nextAttemptAt = validDate(getInternalSetting<string>(NEXT_ATTEMPT_KEY));
  return {
    featureEnabled,
    storageRightsConfirmed,
    enabled,
    due: enabled && isFmpTranscriptRefreshDue(now),
    capability: enabled ? lastCapability?.status ?? "unknown" : "disabled",
    ...(lastCapability ? { lastCapability } : {}),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(nextAttemptAt ? { nextAttemptAt } : {}),
    ingestedCount: ingestedAccessionCountForDocType(FMP_TRANSCRIPT_DOC_TYPE)
  };
}

export interface FmpTranscriptRightsInventory {
  providerVectorIds: string[];
  localVectorIds: string[];
  contentHashes: string[];
  commitIds: string[];
  versionIds: string[];
  ingestionRows: number;
  observationKeys: string[];
  derivedAuditIds: string[];
  derivedArtifactPolicy: "delete-provenance-tagged-retain-unattributable";
}

function rightsInventoryScanMaxRecords(): number {
  return positiveInt(process.env.FMP_TRANSCRIPT_RIGHTS_SCAN_MAX_RECORDS, 250_000, 1_000_000);
}

function localFmpTranscriptRightsInventory(): Omit<FmpTranscriptRightsInventory, "providerVectorIds"> {
  const database = getDb();
  const occurrences = database.prepare(`
    SELECT vector_id, content_hash, commit_id
    FROM chunk_occurrences WHERE source = ? ORDER BY vector_id
  `).all(FMP_TRANSCRIPT_SOURCE) as Array<{
    vector_id: string;
    content_hash: string;
    commit_id: string | null;
  }>;
  const versionIds = (database.prepare(`
    SELECT version_id FROM fmp_transcript_versions ORDER BY version_id
  `).all() as Array<{ version_id: string }>).map((row) => row.version_id);
  const observationKeys = (database.prepare(`
    SELECT key FROM settings
    WHERE key LIKE ? OR key IN (?, ?, ?, ?, ?, ?)
    ORDER BY key
  `).all(
    `${OBSERVATION_PREFIX}%`,
    LAST_ATTEMPT_KEY,
    NEXT_ATTEMPT_KEY,
    CURSOR_KEY,
    CAPABILITY_KEY,
    BODY_RETRY_ACCESSION_KEY,
    EMBED_RETRY_ACCESSION_KEY
  ) as Array<{ key: string }>).map((row) => row.key);
  const derivedAuditIds = (database.prepare(`
    SELECT id FROM audit_events
    WHERE kind LIKE 'fmp_transcript_%'
       OR payload LIKE ? OR payload LIKE ?
    ORDER BY id
  `).all(`%${FMP_TRANSCRIPT_SOURCE}%`, `%${FMP_TRANSCRIPT_DOC_TYPE}%`) as Array<{ id: string }>).map((row) => row.id);
  const ingestionRows = (database.prepare(`
    SELECT COUNT(*) AS count FROM ingested_accessions WHERE doc_type = ?
  `).get(FMP_TRANSCRIPT_DOC_TYPE) as { count: number }).count;
  return {
    localVectorIds: occurrences.map((row) => row.vector_id),
    contentHashes: [...new Set(occurrences.map((row) => row.content_hash))].sort(),
    commitIds: [...new Set(occurrences.map((row) => row.commit_id).filter((id): id is string => Boolean(id)))].sort(),
    versionIds,
    ingestionRows,
    observationKeys,
    derivedAuditIds,
    // Existing decisions do not carry exact per-evidence provenance and cannot be safely guessed.
    // Delete every source/doc-type-tagged candidate/audit artifact; retain unattributable aggregate
    // decisions until provenance exists rather than deleting unrelated owner history.
    derivedArtifactPolicy: "delete-provenance-tagged-retain-unattributable"
  };
}

/** Provider inventory is authoritative and therefore includes receiptless crash ghosts. */
export async function inventoryFmpTranscriptRightsArtifacts(): Promise<FmpTranscriptRightsInventory> {
  const { inventoryVectorRecordsByMetadata } = await import("../vector-db");
  const provider = await inventoryVectorRecordsByMetadata({
    userId: "local",
    source: FMP_TRANSCRIPT_SOURCE,
    maxScanned: rightsInventoryScanMaxRecords()
  });
  return {
    providerVectorIds: provider.map((row) => row.id),
    ...localFmpTranscriptRightsInventory()
  };
}

/**
 * Deterministic rights-off purge. Defaults to dry-run. A real run deletes provider vectors first,
 * verifies Pinecone has none left, then removes exact relational/observation/provenance-tagged
 * derived rows in one SQLite transaction.
 */
export async function purgeFmpTranscriptRightsArtifacts(options: { dryRun?: boolean } = {}): Promise<{
  dryRun: boolean;
  before: FmpTranscriptRightsInventory;
  after: FmpTranscriptRightsInventory;
}> {
  const dryRun = options.dryRun !== false;
  const before = await inventoryFmpTranscriptRightsArtifacts();
  if (dryRun) return { dryRun, before, after: before };
  const { purgeVectorRecordsByMetadata } = await import("../vector-db");
  await purgeVectorRecordsByMetadata({
    userId: "local",
    source: FMP_TRANSCRIPT_SOURCE,
    dryRun: false,
    maxScanned: rightsInventoryScanMaxRecords()
  });
  const providerVerification = await inventoryFmpTranscriptRightsArtifacts();
  if (providerVerification.providerVectorIds.length > 0) {
    throw new Error(`FMP transcript provider purge incomplete (${providerVerification.providerVectorIds.length} vector(s) remain).`);
  }

  const database = getDb();
  database.transaction(() => {
    for (const auditId of before.derivedAuditIds) {
      database.prepare("DELETE FROM audit_events WHERE id = ?").run(auditId);
    }
    database.prepare("DELETE FROM chunk_occurrences WHERE source = ?").run(FMP_TRANSCRIPT_SOURCE);
    for (const contentHash of before.contentHashes) {
      database.prepare(`
        DELETE FROM document_chunks
        WHERE content_hash = ?
          AND NOT EXISTS (SELECT 1 FROM chunk_occurrences WHERE content_hash = ?)
      `).run(contentHash, contentHash);
    }
    database.prepare("DELETE FROM vector_ingest_commits WHERE source = ?").run(FMP_TRANSCRIPT_SOURCE);
    database.prepare("DELETE FROM fmp_transcript_versions").run();
    database.prepare("DELETE FROM ingested_accessions WHERE doc_type = ?").run(FMP_TRANSCRIPT_DOC_TYPE);
    for (const key of before.observationKeys) database.prepare("DELETE FROM settings WHERE key = ?").run(key);
  })();
  const after = await inventoryFmpTranscriptRightsArtifacts();
  const residual = after.providerVectorIds.length + after.localVectorIds.length + after.versionIds.length +
    after.ingestionRows + after.observationKeys.length + after.derivedAuditIds.length;
  if (residual !== 0) throw new Error(`FMP transcript rights purge verification failed (${residual} artifact(s) remain).`);
  return { dryRun, before, after };
}

function recordCapability(
  status: FmpTranscriptCapabilityObservation["status"],
  checkedAt: string,
  httpStatus?: number
): void {
  setInternalSetting(CAPABILITY_KEY, {
    status,
    checkedAt,
    ...(httpStatus !== undefined ? { httpStatus } : {})
  } satisfies FmpTranscriptCapabilityObservation);
}

function emptyResult(enabled = fmpTranscriptsEnabled()): RefreshFmpTranscriptsResult {
  const reason = enabled ? undefined : disabledReason();
  return {
    enabled,
    capability: enabled ? "unknown" : "disabled",
    ...(reason ? { disabledReason: reason } : {}),
    requests: 0,
    symbolsAttempted: 0,
    transcriptsAttempted: 0,
    ingested: 0,
    skippedExisting: 0,
    retryableEmpty: 0,
    deferredForRequestBudget: 0,
    deferredForProviderQuota: 0,
    deferredForEmbedBudget: 0,
    errors: []
  };
}

function describeFailure(stage: "dates" | "body", symbol: string, request: FmpRequestResult & { ok: false }): string {
  const suffix = request.kind === "endpoint_not_entitled"
    ? ":endpoint_not_entitled"
    : request.status
      ? `:http-${request.status}`
      : request.circuitOpen
        ? ":circuit-open"
        : `:${request.kind}`;
  return `${stage}:${symbol}${suffix}`;
}

function markDeferral(result: RefreshFmpTranscriptsResult, request: FmpRequestResult & { ok: false }): void {
  if (request.kind === "request_budget") result.deferredForRequestBudget += 1;
  if (request.kind === "provider_quota") result.deferredForProviderQuota += 1;
}

function clearBodyRetryAccession(accession: string): void {
  if (getInternalSetting<string>(BODY_RETRY_ACCESSION_KEY) === accession) {
    deleteInternalSetting(BODY_RETRY_ACCESSION_KEY);
  }
}

function clearEmbedRetryAccession(accession: string): void {
  if (getInternalSetting<string>(EMBED_RETRY_ACCESSION_KEY) === accession) {
    deleteInternalSetting(EMBED_RETRY_ACCESSION_KEY);
  }
}

/** Return true for the first consecutive store failure; false on the second so the cursor rotates. */
function prioritizeEmbedRetry(accession: string): boolean {
  if (getInternalSetting<string>(EMBED_RETRY_ACCESSION_KEY) === accession) {
    deleteInternalSetting(EMBED_RETRY_ACCESSION_KEY);
    return false;
  }
  setInternalSetting(EMBED_RETRY_ACCESSION_KEY, accession);
  return true;
}

function shouldRetrySoon(result: RefreshFmpTranscriptsResult): boolean {
  return (
    result.retryableEmpty > 0 ||
    result.deferredForRequestBudget > 0 ||
    result.deferredForProviderQuota > 0 ||
    result.deferredForEmbedBudget > 0 ||
    result.errors.some((error) => (
      error.endsWith(":transient") ||
      error.endsWith(":circuit-open") ||
      error.endsWith(":invalid-embeddings") ||
      error.endsWith(":failed") ||
      error.endsWith(":empty") ||
      error.endsWith(":incomplete") ||
      /:http-(?:408|409|425|429|5\d\d)$/.test(error)
    ))
  );
}

/**
 * Refresh a demand-ordered symbol list. This function never enables production by itself; with the
 * default flag state it returns before key lookup, lease acquisition, DB markers, or network work.
 */
export async function refreshFmpTranscripts(
  symbols: string[],
  now: number = Date.now(),
  options: RefreshFmpTranscriptOptions = {}
): Promise<OperationLeaseAware<RefreshFmpTranscriptsResult>> {
  if (!Number.isFinite(now)) throw new Error("Invalid FMP transcript refresh time.");
  if (options.userId !== undefined && options.userId !== "local") {
    throw new Error("FMP transcript ingestion is an operator-owned shared producer; user-scoped runs are not allowed.");
  }
  const base = emptyResult();
  if (!base.enabled) return base;
  const ordered = rotateSymbolsAfterCursor(symbols, getInternalSetting<string>(CURSOR_KEY));
  if (ordered.length === 0) return base;
  if (!options.force && !isFmpTranscriptRefreshDue(now)) return base;

  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "scheduled-fmp-transcripts" },
    async (claim, signal) => refreshFmpTranscriptsUnlocked(ordered, now, options, claim, signal)
  );
  if (!guarded.acquired) return { ...base, operationLease: guarded.busy };
  return guarded.value;
}

async function refreshFmpTranscriptsUnlocked(
  orderedSymbols: string[],
  now: number,
  options: RefreshFmpTranscriptOptions,
  claim: OperationLeaseClaim,
  leaseSignal: AbortSignal
): Promise<RefreshFmpTranscriptsResult> {
  const result = emptyResult(true);
  if (!options.force && !isFmpTranscriptRefreshDue(now)) return result;
  assertOperationLeaseOwnership(claim);
  const observedAt = new Date(now).toISOString();
  const userId = "local";
  const resolved = resolveApiKeyWithSource("fmp", userId);

  // Provisional retry marker first: a crash cannot make every 60-second scheduler tick restart the
  // same provider batch. A clean completion below advances it to the normal independent cadence.
  setInternalSetting(LAST_ATTEMPT_KEY, observedAt);
  setInternalSetting(NEXT_ATTEMPT_KEY, new Date(now + retryMs()).toISOString());

  if (!resolved.key) {
    result.errors.push("configuration:fmp-key-unavailable");
    setInternalSetting(NEXT_ATTEMPT_KEY, new Date(now + ttlMs()).toISOString());
    audit("fmp_transcript_refresh", { ...result, contentLogged: false, featureDefault: "off" });
    return result;
  }

  const budget: RequestBudget = {
    remaining: options.maxRequests === undefined
      ? maxRequestsPerRun()
      : nonNegativeInt(options.maxRequests, 0, 500),
    used: 0
  };

  symbolLoop: for (const symbol of orderedSymbols) {
    throwIfOperationLeaseCancelled(leaseSignal);
    assertOperationLeaseOwnership(claim);
    if (budget.remaining <= 0) {
      result.deferredForRequestBudget += 1;
      break;
    }
    result.symbolsAttempted += 1;
    const dates = await requestFmpJson(
      endpoint("earning-call-transcript-dates", { symbol }),
      resolved.key,
      resolved.source,
      userId,
      budget,
      httpRetries(),
      datesResponseBytes(),
      "dates",
      claim,
      leaseSignal
    );
    // Defense in depth around every provider helper return: no caller-side cursor/capability write
    // may trust a result that settled after durable ownership moved.
    throwIfOperationLeaseCancelled(leaseSignal);
    assertOperationLeaseOwnership(claim);
    if (!dates.ok) {
      // Advance after an actual failed dates request so one bad ticker cannot starve the demand
      // list. Admission failures did not contact FMP and must retry this same symbol next run.
      if (dates.kind !== "request_budget" && dates.kind !== "provider_quota") {
        setInternalSetting(CURSOR_KEY, symbol);
      }
      markDeferral(result, dates);
      result.errors.push(describeFailure("dates", symbol, dates));
      if (dates.kind === "endpoint_not_entitled") {
        result.capability = "endpoint_not_entitled";
        recordCapability("endpoint_not_entitled", observedAt, dates.status ?? 402);
        break;
      }
      if (dates.kind === "request_budget" || dates.kind === "provider_quota") break;
      continue;
    }

    const refs = parseFmpTranscriptDates(dates.payload, symbol);
    if (refs.length === 0) {
      // A successful-but-empty dates response is not proof that this ticker will never have data.
      // Keep it retryable and never write a synthetic ingestion row.
      result.retryableEmpty += 1;
      result.errors.push(`dates:${symbol}:empty`);
      setInternalSetting(CURSOR_KEY, symbol);
      continue;
    }
    assertOperationLeaseOwnership(claim);
    for (const ref of refs) observeReference(ref, dates.receivedAt);

    const pendingRetry =
      getInternalSetting<string>(BODY_RETRY_ACCESSION_KEY) ??
      getInternalSetting<string>(EMBED_RETRY_ACCESSION_KEY);
    const retryIndex = pendingRetry
      ? refs.findIndex((ref) => transcriptAccession(ref.symbol, ref.year, ref.quarter) === pendingRetry)
      : -1;
    const refsInAttemptOrder = retryIndex > 0
      ? [refs[retryIndex]!, ...refs.slice(0, retryIndex), ...refs.slice(retryIndex + 1)]
      : refs;
    const refsToAttempt: FmpTranscriptRef[] = [];
    for (const ref of refsInAttemptOrder) {
      // Re-fetch a bounded recent set even after initial ingestion: FMP can correct a transcript
      // body without changing symbol/year/quarter. Body SHA-256 below distinguishes versions and
      // preserves the older PIT version rather than overwriting it.
      refsToAttempt.push(ref);
      if (refsToAttempt.length >= maxTranscriptsPerSymbol()) break;
    }

    let retrySameSymbol = false;
    for (const ref of refsToAttempt) {
      const accession = transcriptAccession(ref.symbol, ref.year, ref.quarter);
      const { hasIngestTextBudget } = await import("../vector-db");
      if (!hasIngestTextBudget(userId)) {
        result.deferredForEmbedBudget += 1;
        retrySameSymbol = true;
        break;
      }
      if (budget.remaining <= 0) {
        result.deferredForRequestBudget += 1;
        retrySameSymbol = true;
        break;
      }

      result.transcriptsAttempted += 1;
      const body = await requestFmpJson(
        endpoint("earning-call-transcript", { symbol: ref.symbol, year: ref.year, quarter: ref.quarter }),
        resolved.key,
        resolved.source,
        userId,
        budget,
        httpRetries(),
        transcriptResponseBytes(),
        "body",
        claim,
        leaseSignal
      );
      throwIfOperationLeaseCancelled(leaseSignal);
      assertOperationLeaseOwnership(claim);
      if (!body.ok) {
        markDeferral(result, body);
        result.errors.push(describeFailure("body", ref.symbol, body));
        if (body.kind === "endpoint_not_entitled") {
          clearBodyRetryAccession(accession);
          result.capability = "endpoint_not_entitled";
          recordCapability("endpoint_not_entitled", observedAt, body.status ?? 402);
          break symbolLoop;
        }
        if (body.kind === "request_budget" || body.kind === "provider_quota") {
          retrySameSymbol = true;
          break;
        }
        if (body.kind === "transient") {
          // Retry one failed body accession at the front of the very next run. If it fails again,
          // advance the symbol cursor so one unhealthy period cannot starve a large universe.
          if (getInternalSetting<string>(BODY_RETRY_ACCESSION_KEY) === accession) {
            deleteInternalSetting(BODY_RETRY_ACCESSION_KEY);
          } else {
            setInternalSetting(BODY_RETRY_ACCESSION_KEY, accession);
            retrySameSymbol = true;
          }
          break;
        }
        clearBodyRetryAccession(accession);
        continue;
      }

      clearBodyRetryAccession(accession);
      const transcript = parseFmpTranscriptBody(body.payload, ref);
      if (!transcript) {
        result.retryableEmpty += 1;
        result.errors.push(`body:${ref.symbol}:empty`);
        continue;
      }

      if (result.capability !== "available") {
        result.capability = "available";
        recordCapability("available", body.receivedAt, 200);
      }
      assertOperationLeaseOwnership(claim);
      const observation = observeContent(transcript, body.receivedAt);
      const { contentSha256, versionIdSuffix } = transcriptContentVersion(transcript.content);
      const versionId = `${accession}:${versionIdSuffix}`;
      const version = observeFmpTranscriptVersion({
        versionId,
        accession,
        contentSha256,
        symbol: transcript.symbol,
        year: transcript.year,
        quarter: transcript.quarter,
        callDate: transcript.callDate,
        observedAt: body.receivedAt
      });
      if (version.state === "committed") {
        clearEmbedRetryAccession(accession);
        result.skippedExisting += 1;
        continue;
      }
      setFmpTranscriptVersionState(version.versionId, "indexing", { at: body.receivedAt });
      const { storeDocument } = await import("../vector-db");
      assertOperationLeaseOwnership(claim);
      const stored = await storeDocument(
        {
          text: transcript.content,
          doc_id: version.versionId,
          ticker: transcript.symbol,
          title: `${transcript.symbol} earnings call ${transcript.year} Q${transcript.quarter}`,
          doc_type: FMP_TRANSCRIPT_DOC_TYPE,
          // The call date remains event metadata. If absent, the first observed availability is the
          // only honest publication timestamp we have.
          published_at: transcript.callDate ?? observation.firstContentSeenAt,
          acceptance_datetime: version.firstContentSeenAt,
          source: FMP_TRANSCRIPT_SOURCE,
          // Key-free provider locator. It is stored as metadata but never emitted to logs.
          url: endpoint("earning-call-transcript", {
            symbol: transcript.symbol,
            year: transcript.year,
            quarter: transcript.quarter
          })
        },
        userId,
        {
          contentVersion: contentSha256,
          parserRevision: "fmp-transcript-v1",
          leaseGuard: {
            assertOwnership: () => assertOperationLeaseOwnership(claim),
            signal: leaseSignal
          }
        }
      );
      assertOperationLeaseOwnership(claim);

      if (stored.error) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        result.errors.push(`embed:${transcript.symbol}:failed`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }
      if ((stored.rejectedInvalidEmbeddings ?? 0) > 0) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        // A partial vector write is not a complete transcript. Keep the same symbol/corpus period
        // retryable once so dedup can retain good chunks while rejected chunks are re-embedded.
        // A second consecutive rejection advances the symbol cursor; the accession remains
        // un-ingested and will be retried after the universe rotates instead of starving it.
        result.errors.push(`embed:${transcript.symbol}:invalid-embeddings`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }
      const outOfCapacity =
        stored.unconfigured === true ||
        (stored.budgetSkipped ?? 0) > 0 ||
        (stored.writeUnitBudgetSkipped ?? 0) > 0;
      if (stored.indexed <= 0 || outOfCapacity) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        if (outOfCapacity) {
          result.deferredForEmbedBudget += 1;
          retrySameSymbol = true;
          break;
        }
        result.errors.push(`embed:${transcript.symbol}:empty`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }
      if (stored.documentComplete !== true || stored.indexed !== stored.attempted) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        // Defense in depth: source-level completion requires a real per-occurrence Pinecone write for
        // every chunk plus storeDocument's required local receipt transaction. Content-only dedup or
        // an unexplained partial result stays retryable even if a future caller mislabels it complete.
        result.errors.push(`embed:${transcript.symbol}:incomplete`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }

      clearEmbedRetryAccession(accession);
      assertOperationLeaseOwnership(claim);
      // `attempted` is the complete document chunk count. A retry after a budget-limited partial
      // write may index only the remaining chunks; persisting only this run's indexed delta would
      // make the completion ledger/admin coverage permanently undercount the transcript.
      recordIngestedTranscript(accession, transcript.symbol, stored.attempted, body.receivedAt);
      setFmpTranscriptVersionState(version.versionId, "committed", {
        vectorCommitId: (() => {
          const row = getDb().prepare(`
            SELECT id FROM vector_ingest_commits
            WHERE source = ? AND accession = ? AND content_version = ? AND state = 'committed'
            ORDER BY committed_at DESC LIMIT 1
          `).get(FMP_TRANSCRIPT_SOURCE, version.versionId, contentSha256) as { id: string } | undefined;
          return row?.id;
        })(),
        chunkCount: stored.attempted,
        at: body.receivedAt
      });
      result.ingested += 1;
      audit("fmp_transcript_ingest", {
        accession,
        versionId: version.versionId,
        contentSha256,
        symbol: transcript.symbol,
        year: transcript.year,
        quarter: transcript.quarter,
        callDate: observation.callDate,
        firstContentSeenAt: version.firstContentSeenAt,
        availabilityBasis: "first_observed_by_app",
        chunks: stored.attempted,
        indexedThisAttempt: stored.indexed,
        contentLogged: false
      });
    }
    if (retrySameSymbol) break;
    setInternalSetting(CURSOR_KEY, symbol);
  }

  result.requests = budget.used;
  assertOperationLeaseOwnership(claim);
  if (result.capability === "endpoint_not_entitled") {
    setInternalSetting(NEXT_ATTEMPT_KEY, new Date(now + notEntitledRetryMs()).toISOString());
  } else if (!shouldRetrySoon(result)) {
    setInternalSetting(NEXT_ATTEMPT_KEY, new Date(now + ttlMs()).toISOString());
  }
  audit("fmp_transcript_refresh", {
    ...result,
    cursor: getInternalSetting<string>(CURSOR_KEY),
    contentLogged: false,
    featureDefault: "off"
  });
  return result;
}
