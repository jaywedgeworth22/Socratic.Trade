export type InFlightGroup =
  | "rag-reindex"
  | "backtest-ic"
  | "congress-score-eval"
  | "congress-share"
  | "refresh-websource"
  | "robinhood-probe"
  | "stale-exit"
  | "stop-monitor";

type InFlightGuardHost = typeof globalThis & {
  __socraticOperationsInFlight?: Map<string, symbol>;
};

const host = globalThis as InFlightGuardHost;
const inFlight = (host.__socraticOperationsInFlight ??= new Map<string, symbol>());

export type InFlightConflictResult = { inFlightConflict: true; activeOperation: string };

/**
 * Acquire a single-flight execution lock for the given concurrency group.
 * If the lock is already held, returns an InFlightConflictResult immediately.
 * Otherwise, executes the provided run() function and guarantees lock release on completion/throw.
 *
 * @param group The concurrency group key.
 * @param run The operation to run while the lock is held.
 */
export async function withInFlightGuard<T>(
  group: InFlightGroup | string,
  run: () => Promise<T>
): Promise<T | InFlightConflictResult> {
  const active = inFlight.has(group);
  if (active) {
    return { inFlightConflict: true, activeOperation: group };
  }

  const token = Symbol(group);
  inFlight.set(group, token);
  try {
    return await run();
  } finally {
    if (inFlight.get(group) === token) {
      inFlight.delete(group);
    }
  }
}

/** Test/maintenance hook. */
export function resetOperationsInFlight(): void {
  inFlight.clear();
}
