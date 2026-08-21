import { withDeadline } from "./inflight-deadline";
import { newestPersistedMarketScan } from "./market-scan-freshness";
import { mergeQuoteData, scanMarket } from "./market";
import { normalizeSymbol } from "./money";
import { fetchFreshQuotesCascade } from "./quotes-cascade";
import type { EquityPosition, IndexUniverse, MarketScan, ScoringWeights, TradingPolicy, UniverseFloor } from "./types";

/**
 * Live Roth `9d71dda4` sat in gather from 00:58:57Z until sweep-failed 01:29:44Z
 * (`stalled_no_progress`, llm=0).  Bound scan + quote cascade so a hung
 * Robinhood/Yahoo/congress.trade pass cannot keep the claimed request
 * `running` until the 30m sweep.  Green starts after this returns.
 */
export const STRATEGY_GATHER_DEADLINE_MS = 8 * 60_000;
export const STRATEGY_GATHER_TIMEOUT_MESSAGE = "strategy gather timeout";
/** Short quote refresh after a timed-out scan, using the last completed tape. */
export const STRATEGY_GATHER_QUOTE_FALLBACK_MS = 45_000;

export type StrategyGatherResult = {
  baseMarketScan: MarketScan;
  marketScan: MarketScan;
  usedLastGood: boolean;
  lastGoodAt?: string;
};

export type StrategyGatherInput = {
  allowedSymbols: string[];
  positions: EquityPosition[];
  scanWeights: ScoringWeights;
  userId: string;
  dynamicUniverses: IndexUniverse[];
  connectedAccountId?: string;
  accountNumber?: string;
  candidateLimit?: number;
  outlierReserve?: number;
  universeFloor?: UniverseFloor;
  congressMultiplier?: number;
  deadlineMs?: number;
  quoteFallbackMs?: number;
};

function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
}

export function throwIfGatherAborted(signal: AbortSignal | undefined, message = STRATEGY_GATHER_TIMEOUT_MESSAGE): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(message);
}

function withLastGoodWarning(scan: MarketScan, lastGoodAt: string, deadlineMs: number): MarketScan {
  const warning =
    `Live gather timed out after ${deadlineMs}ms; using the last completed scan from ${lastGoodAt} and a short quote refresh.`;
  return {
    ...scan,
    warnings: [...scan.warnings, warning]
  };
}

async function refreshTopCandidateQuotes(
  scan: MarketScan,
  input: StrategyGatherInput,
  signal: AbortSignal
): Promise<MarketScan> {
  const quoteSymbols = uniqueSymbols(scan.topCandidates.map((quote) => quote.symbol));
  throwIfGatherAborted(signal);
  const quotes = await fetchFreshQuotesCascade(
    quoteSymbols,
    input.userId,
    input.accountNumber,
    input.connectedAccountId,
    { signal }
  );
  throwIfGatherAborted(signal);
  return mergeQuoteData(scan, quotes);
}

/**
 * Scan + fresh top-candidate quotes for one strategy run.
 *
 * The 8-minute deadline MUST abort the in-flight work.  `withDeadline` without a
 * controller is a pure race: the caller marks the run failed and the next account
 * starts another full scan while the abandoned Nasdaq/enrichment/broker walk keeps
 * the sockets and the event loop.  That pile-up is why Roth + Paper spent 2026-08-21
 * RTH on `strategy gather timeout` after both completed the prior close.
 *
 * When the live scan still cannot finish, reuse the newest persisted MarketScan
 * (real last tape, not a fabricated book) plus a short quote refresh so Green can
 * start.  No last-good row still fails the run — there is nothing honest to decide on.
 */
export async function gatherStrategyMarket(input: StrategyGatherInput): Promise<StrategyGatherResult> {
  const deadlineMs = input.deadlineMs ?? STRATEGY_GATHER_DEADLINE_MS;
  const quoteFallbackMs = input.quoteFallbackMs ?? STRATEGY_GATHER_QUOTE_FALLBACK_MS;
  const controller = new AbortController();
  const { signal } = controller;

  try {
    return await withDeadline(
      (async () => {
        const scanned = await scanMarket(
          input.allowedSymbols,
          input.positions,
          input.scanWeights,
          input.userId,
          input.dynamicUniverses,
          {
            candidateLimit: input.candidateLimit,
            outlierReserve: input.outlierReserve,
            universeFloor: input.universeFloor,
            congressMultiplier: input.congressMultiplier,
            signal
          }
        );
        throwIfGatherAborted(signal);
        return {
          baseMarketScan: scanned,
          marketScan: await refreshTopCandidateQuotes(scanned, input, signal),
          usedLastGood: false
        };
      })(),
      deadlineMs,
      STRATEGY_GATHER_TIMEOUT_MESSAGE,
      { controller }
    );
  } catch (error) {
    const timedOut =
      error instanceof Error && error.message === STRATEGY_GATHER_TIMEOUT_MESSAGE;
    if (!timedOut) throw error;

    const lastGood = newestPersistedMarketScan(input.userId, input.connectedAccountId);
    if (!lastGood) throw error;

    const seeded = withLastGoodWarning(lastGood.scan, lastGood.entry.createdAt, deadlineMs);
    const quoteController = new AbortController();
    let marketScan = seeded;
    try {
      marketScan = await withDeadline(
        refreshTopCandidateQuotes(seeded, input, quoteController.signal),
        quoteFallbackMs,
        "strategy gather quote fallback timeout",
        { controller: quoteController }
      );
    } catch {
      // Last-good prices stay.  A second hang must not fail the run after we already
      // chose the honest tape over an empty gather.
    }
    return {
      baseMarketScan: seeded,
      marketScan,
      usedLastGood: true,
      lastGoodAt: lastGood.entry.createdAt
    };
  }
}

export function gatherPolicySlice(policy: Pick<
  TradingPolicy,
  "marketScanCandidateLimit" | "marketScanOutlierReserve" | "universeFloor" | "accountNumber"
>): Pick<StrategyGatherInput, "candidateLimit" | "outlierReserve" | "universeFloor" | "accountNumber"> {
  return {
    candidateLimit: policy.marketScanCandidateLimit,
    outlierReserve: policy.marketScanOutlierReserve,
    universeFloor: policy.universeFloor,
    accountNumber: policy.accountNumber
  };
}
