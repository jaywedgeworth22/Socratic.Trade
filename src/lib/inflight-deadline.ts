/**
 * First-call retry for a broker (or other) read that may be slow or hung after a
 * process swap, without treating a real rejection as success.
 *
 * Verified production shape (2026-08-18 ops snapshot): dashboard races
 * `gateway.getAccounts()` at 6s, then `accountReadinessForSnapshot` fail-closes
 * Manual Run once on that timeout string.  Paper / Roth are Alpaca REST, not MCP.
 * A single slow or hung first `getAccount` must not hard-fail Run once; a 401 /
 * credential throw still fails immediately (no retry).
 */

export const GET_ACCOUNTS_FIRST_MS = 6_000;
export const GET_ACCOUNTS_RETRY_MS = 9_000;
export const PORTFOLIO_BUNDLE_FIRST_MS = 8_000;
export const PORTFOLIO_BUNDLE_RETRY_MS = 7_000;
export const ALPACA_ACCOUNT_READ_FIRST_MS = 5_000;
export const ALPACA_ACCOUNT_READ_RETRY_MS = 10_000;
export const ALPACA_MCP_FETCH_MS = 8_000;

export type SettleKind = "fulfilled" | "rejected" | "pending";

export type SettleOutcome<T> =
  | { kind: "fulfilled"; value: T }
  | { kind: "rejected"; reason: unknown }
  | { kind: "pending" };

export function getAccountsTimeoutMessage(firstMs = GET_ACCOUNTS_FIRST_MS, retryMs = GET_ACCOUNTS_RETRY_MS): string {
  return `Timed out waiting for gateway.getAccounts after ${firstMs}+${retryMs}ms.`;
}

export function portfolioBundleTimeoutMessage(
  firstMs = PORTFOLIO_BUNDLE_FIRST_MS,
  retryMs = PORTFOLIO_BUNDLE_RETRY_MS
): string {
  return `Timed out waiting for portfolio, positions, and orders after ${firstMs}+${retryMs}ms.`;
}

export async function outcomeOrTimeout<T>(promise: Promise<T>, ms: number): Promise<SettleOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "pending" });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "fulfilled", value });
      },
      (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "rejected", reason });
      }
    );
  });
}

/** First fulfillment wins.  Rejection wins only after every sibling has rejected. */
export async function firstOutcomeOf<T>(promises: readonly Promise<T>[], ms: number): Promise<SettleOutcome<T>> {
  return new Promise((resolve) => {
    let done = false;
    let pendingRejects = promises.length;
    let lastReason: unknown;
    const finish = (outcome: SettleOutcome<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "pending" }), ms);
    for (const promise of promises) {
      promise.then(
        (value) => finish({ kind: "fulfilled", value }),
        (reason) => {
          lastReason = reason;
          pendingRejects -= 1;
          if (pendingRejects === 0) finish({ kind: "rejected", reason: lastReason });
        }
      );
    }
  });
}

function assertNever(value: never): never {
  throw new Error(`unhandled settle kind: ${String(value)}`);
}

export async function awaitWithFirstCallRetry<T>(
  start: () => Promise<T>,
  options: {
    firstMs: number;
    retryMs: number;
    onFinalTimeout: () => T;
    label?: string;
    timedOutSections?: string[];
  }
): Promise<T> {
  const first = start();
  const firstOutcome = await outcomeOrTimeout(first, options.firstMs);
  switch (firstOutcome.kind) {
    case "fulfilled":
      return firstOutcome.value;
    case "rejected":
      throw firstOutcome.reason;
    case "pending":
      break;
    default:
      return assertNever(firstOutcome);
  }

  const retry = start();
  const raced = await firstOutcomeOf([first, retry], options.retryMs);
  switch (raced.kind) {
    case "fulfilled":
      return raced.value;
    case "rejected":
      throw raced.reason;
    case "pending":
      if (options.label) {
        console.warn(
          `[dashboard] ${options.label} timed out after ${options.firstMs}+${options.retryMs}ms — serving degraded snapshot section`
        );
        options.timedOutSections?.push(options.label);
      }
      return options.onFinalTimeout();
    default:
      return assertNever(raced);
  }
}
