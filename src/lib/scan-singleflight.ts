import type {
  EquityPosition,
  IndexUniverse,
  MarketQuoteSummary,
  MarketScan,
  ScoringWeights,
  UniverseFloor
} from "./types";

const MAX_INTERACTIVE_SEED_AGE_MS = 24 * 60 * 60_000;

/**
 * Coalesce identical interactive refreshes. A page mount and a quick manual retry
 * must share one upstream scan instead of multiplying provider work.
 */
const activeScans = new Map<string, Promise<MarketScan>>();

export function interactiveScanKey(input: {
  userId: string;
  accountNumber?: string;
  symbols: string[];
  candidateLimit?: number;
  outlierReserve?: number;
  dynamicUniverses: IndexUniverse[];
  latestRunAuditId?: string;
  scoringWeights: ScoringWeights;
  universeFloor?: UniverseFloor;
  positions: EquityPosition[];
}): string {
  const positions = input.positions
    .map((position) => ({
      symbol: position.symbol.trim().toUpperCase(),
      marketValue: position.marketValue,
      sector: position.sector ?? "",
      industry: position.industry ?? ""
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return JSON.stringify({
    userId: input.userId,
    accountNumber: input.accountNumber ?? "",
    symbols: [...input.symbols].sort(),
    candidateLimit: input.candidateLimit,
    outlierReserve: input.outlierReserve,
    dynamicUniverses: [...input.dynamicUniverses].sort(),
    latestRunAuditId: input.latestRunAuditId ?? "",
    scoringWeights: input.scoringWeights,
    universeFloor: input.universeFloor,
    positions
  });
}

export async function withScanDeadline<T>(
  budgetMs: number,
  factory: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  return await new Promise<T>((resolve, reject) => {
    const deadlineError = new Error("Interactive market scan deadline exceeded.");
    const timeout = setTimeout(() => {
      controller.abort(deadlineError);
      reject(deadlineError);
    }, Math.max(1, budgetMs));
    timeout.unref?.();
    void Promise.resolve()
      .then(() => factory(controller.signal))
      .then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      );
  });
}

export function runScanSingleFlight(
  key: string,
  factory: () => Promise<MarketScan>
): Promise<MarketScan> {
  const existing = activeScans.get(key);
  if (existing) return existing;

  const pending = Promise.resolve().then(factory);
  activeScans.set(key, pending);
  const clear = () => {
    if (activeScans.get(key) === pending) activeScans.delete(key);
  };
  // Attach both handlers to the original promise. `finally()` would create a
  // rejected child promise that nobody observes when the scan fails.
  void pending.then(clear, clear);
  return pending;
}

export function resetScanSingleFlightForTests(): void {
  activeScans.clear();
}

/**
 * Read the full per-symbol quote map from a persisted strategy-run audit without
 * trusting an older compact prompt snapshot or a malformed audit payload.
 */
export function marketScanQuotesFromAudit(
  payload: unknown,
  createdAt?: string,
  now = Date.now()
): Record<string, MarketQuoteSummary> | undefined {
  const timestamp = Date.parse(createdAt ?? "");
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000 || now - timestamp > MAX_INTERACTIVE_SEED_AGE_MS) {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const marketScan = (payload as { marketScan?: unknown }).marketScan;
  if (!marketScan || typeof marketScan !== "object") return undefined;
  const quotes = (marketScan as { quotesBySymbol?: unknown }).quotesBySymbol;
  if (!quotes || typeof quotes !== "object" || Array.isArray(quotes)) return undefined;

  const entries = Object.entries(quotes);
  if (entries.length === 0) return undefined;
  const valid = entries.every(([symbol, value]) => {
    if (!symbol || !value || typeof value !== "object" || Array.isArray(value)) return false;
    const quote = value as { symbol?: unknown; price?: unknown; score?: unknown };
    return quote.symbol === symbol
      && typeof quote.price === "number"
      && Number.isFinite(quote.price)
      && typeof quote.score === "number"
      && Number.isFinite(quote.score);
  });
  return valid ? quotes as Record<string, MarketQuoteSummary> : undefined;
}
