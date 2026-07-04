import {
  getCounterfactualLearningWatermark,
  insertSkippedCounterfactualCandidate,
  listPendingSkippedCounterfactuals,
  listSignalSnapshotAuditAfter,
  markSkippedCounterfactualChecked,
  markSkippedCounterfactualMatured,
  setCounterfactualLearningWatermark
} from "./db";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import type { OHLCBar } from "./indicators";
import { addTradingDays } from "./market-calendar";
import { normalizeSymbol } from "./money";
import type { MarketFactor, MarketFactorBreakdown } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_HORIZON_DAYS = 5;
const DEFAULT_AUDIT_LIMIT = 100;
const DEFAULT_PENDING_LIMIT = 50;
const DEFAULT_RECHECK_MS = 6 * 60 * 60_000;

export type CounterfactualOHLCFetcher = (symbol: string, now?: number, userId?: string) => Promise<OHLCBar[] | null>;

export interface CounterfactualMaterializationOptions {
  now?: number;
  /** Scope learning to one connected account: read only its snapshots, tag its candidates, keep its own watermark. */
  connectedAccountId?: string;
  horizonDays?: number;
  auditLimit?: number;
  pendingLimit?: number;
  recheckMs?: number;
  fetchOHLC?: CounterfactualOHLCFetcher;
}

export interface CounterfactualMaterializationResult {
  auditRowsScanned: number;
  candidatesInserted: number;
  pendingChecked: number;
  materialized: number;
}

interface SignalSnapshotPayload {
  runId?: string;
  asOf?: string;
  signals?: Array<{
    symbol?: string;
    chosen?: boolean;
    refPrice?: number;
    score?: number;
    sector?: string;
    regime?: string;
    factorBreakdown?: MarketFactorBreakdown;
    bulletins?: string[];
  }>;
}

/**
 * Materializes skipped-candidate counterfactuals once their holding window has
 * matured. It never writes fills/orders and never infers prices: no OHLC bar means
 * the candidate remains pending for a later bounded retry.
 */
export async function materializeSkippedCandidateCounterfactuals(
  userId: string = "local",
  options: CounterfactualMaterializationOptions = {}
): Promise<CounterfactualMaterializationResult> {
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const horizonDays = boundedInteger(options.horizonDays ?? envHorizonDays(), 1, 252, DEFAULT_HORIZON_DAYS);
  const auditLimit = boundedInteger(options.auditLimit, 1, 500, DEFAULT_AUDIT_LIMIT);
  const pendingLimit = boundedInteger(options.pendingLimit, 1, 500, DEFAULT_PENDING_LIMIT);
  const recheckMs = boundedInteger(options.recheckMs, 60_000, 7 * DAY_MS, DEFAULT_RECHECK_MS);
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;

  const connectedAccountId = options.connectedAccountId;
  const watermark = getCounterfactualLearningWatermark(userId, connectedAccountId);
  const auditRows = listSignalSnapshotAuditAfter(userId, watermark, auditLimit, connectedAccountId);
  let candidatesInserted = 0;

  for (const row of auditRows) {
    candidatesInserted += ingestSignalSnapshot(row.payload, {
      userId,
      connectedAccountId,
      createdAt: row.createdAt,
      horizonDays,
      nowIso
    });
  }

  const lastAudit = auditRows[auditRows.length - 1];
  if (lastAudit) {
    setCounterfactualLearningWatermark({
      userId,
      connectedAccountId,
      lastAuditRowid: lastAudit.rowid,
      lastAuditCreatedAt: lastAudit.createdAt,
      lastAuditId: lastAudit.id,
      updatedAt: nowIso
    });
  }

  const checkedBefore = new Date(now - recheckMs).toISOString();
  const pending = listPendingSkippedCounterfactuals({
    userId,
    nowDate: new Date(now).toISOString().slice(0, 10),
    checkedBefore,
    limit: pendingLimit
  });

  const barsBySymbol = new Map<string, OHLCBar[] | null>();
  let pendingChecked = 0;
  let materialized = 0;

  for (const candidate of pending) {
    let bars = barsBySymbol.get(candidate.symbol);
    if (bars === undefined) {
      bars = await fetchOHLC(candidate.symbol, now, userId);
      barsBySymbol.set(candidate.symbol, bars);
    }

    const exit = bars ? selectExitBar(bars, candidate.targetDate) : undefined;
    if (!exit) {
      markSkippedCounterfactualChecked(candidate.id, userId, nowIso);
      pendingChecked += 1;
      continue;
    }

    const returnPct = Number((((exit.close - candidate.refPrice) / candidate.refPrice) * 100).toFixed(2));
    if (
      markSkippedCounterfactualMatured({
        id: candidate.id,
        userId,
        exitDate: exit.date,
        exitPrice: exit.close,
        returnPct,
        checkedAt: nowIso
      })
    ) {
      materialized += 1;
    }
    pendingChecked += 1;
  }

  return {
    auditRowsScanned: auditRows.length,
    candidatesInserted,
    pendingChecked,
    materialized
  };
}

/**
 * Record a user/policy-REJECTED proposal into the same skipped-candidate counterfactual pipeline so
 * its "what happened after we passed" return matures (via fetchDailyOHLC at the holding horizon) and
 * feeds missed-opportunity analytics — not just the live readout on the dashboard. The existing
 * skipped-candidate set only covers LLM-NOT-CHOSEN names; this closes the gap for names the LLM DID
 * propose but a human/policy then rejected. Additive: reuses insertSkippedCounterfactualCandidate
 * (INSERT OR IGNORE) so it never double-counts and writes no fills/orders. Returns true if inserted.
 */
export function recordRejectedProposalCounterfactual(input: {
  userId?: string;
  connectedAccountId?: string;
  runId: string;
  symbol: string;
  refPrice: number | undefined;
  createdAt: string;
  regime?: string;
  now?: number;
  horizonDays?: number;
}): boolean {
  const userId = input.userId ?? "local";
  const symbol = normalizeSymbol(input.symbol);
  const refPrice = positiveNumber(input.refPrice);
  const nowMs = input.now ?? Date.now();
  const snapshotAt = validIso(input.createdAt) ?? validIso(new Date(nowMs).toISOString());
  if (!symbol || !refPrice || !snapshotAt) return false;
  const horizonDays = boundedInteger(input.horizonDays ?? envHorizonDays(), 1, 252, DEFAULT_HORIZON_DAYS);
  const targetDate = targetBusinessDate(snapshotAt, horizonDays);
  if (!targetDate) return false;
  return insertSkippedCounterfactualCandidate({
    userId,
    connectedAccountId: input.connectedAccountId,
    runId: input.runId,
    symbol,
    snapshotAt,
    refPrice,
    horizonDays,
    targetDate,
    regime: nonEmpty(input.regime),
    now: new Date(nowMs).toISOString()
  });
}

function ingestSignalSnapshot(
  payload: unknown,
  context: { userId: string; connectedAccountId?: string; createdAt: string; horizonDays: number; nowIso: string }
): number {
  const snapshot = payload as SignalSnapshotPayload | undefined;
  if (!snapshot?.runId || !Array.isArray(snapshot.signals)) return 0;
  const snapshotAt = validIso(snapshot.asOf) ?? validIso(context.createdAt);
  if (!snapshotAt) return 0;
  const targetDate = targetBusinessDate(snapshotAt, context.horizonDays);
  if (!targetDate) return 0;

  let inserted = 0;
  for (const signal of snapshot.signals) {
    if (signal.chosen !== false) continue;
    const symbol = normalizeSymbol(signal.symbol ?? "");
    const refPrice = positiveNumber(signal.refPrice);
    if (!symbol || !refPrice) continue;
    if (
      insertSkippedCounterfactualCandidate({
        userId: context.userId,
        connectedAccountId: context.connectedAccountId,
        runId: snapshot.runId,
        symbol,
        snapshotAt,
        refPrice,
        horizonDays: context.horizonDays,
        targetDate,
        score: finiteNumber(signal.score),
        sector: nonEmpty(signal.sector),
        regime: nonEmpty(signal.regime),
        dominantFactor: dominantFactor(signal.factorBreakdown),
        bulletins: cleanBulletins(signal.bulletins),
        now: context.nowIso
      })
    ) {
      inserted += 1;
    }
  }
  return inserted;
}

function selectExitBar(bars: OHLCBar[], targetDate: string): { date: string; close: number } | undefined {
  return bars
    .map((bar) => ({ date: toBusinessDay(bar.time), close: positiveNumber(bar.close) }))
    .filter((bar): bar is { date: string; close: number } => Boolean(bar.date && bar.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .find((bar) => bar.date >= targetDate);
}

/**
 * TRADING-day horizon target (see `market-calendar.addTradingDays` for the full historical
 * note): `horizonDays` trading sessions after `snapshotAt`'s calendar date, honoring weekends
 * and full-close holidays — NOT `horizonDays * 86_400_000` ms of calendar time. Named
 * `targetBusinessDate` to match `backtest.ts`'s identical helper (kept as separate thin
 * wrappers since each module owns its own snapshot-parsing/validation contract).
 */
function targetBusinessDate(snapshotAt: string, horizonDays: number): string | undefined {
  const time = Date.parse(snapshotAt);
  if (!Number.isFinite(time)) return undefined;
  const snapshotDate = new Date(time).toISOString().slice(0, 10);
  return addTradingDays(snapshotDate, horizonDays);
}

function envHorizonDays(): number {
  return Number(process.env.COUNTERFACTUAL_HORIZON_DAYS ?? DEFAULT_HORIZON_DAYS);
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanBulletins(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const bulletins = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 3);
  return bulletins.length > 0 ? bulletins : undefined;
}

function dominantFactor(breakdown?: MarketFactorBreakdown): MarketFactor | undefined {
  if (!breakdown) return undefined;
  let best: { factor: MarketFactor; value: number } | undefined;
  for (const [key, value] of Object.entries(breakdown)) {
    if (key === "weightedTotal") continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    if (!best || numeric > best.value) best = { factor: key as MarketFactor, value: numeric };
  }
  return best?.factor;
}
