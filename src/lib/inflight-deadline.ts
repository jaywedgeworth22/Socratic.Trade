/**
 * First-call retry for an in-process Alpaca REST read, without treating a real
 * rejection as success.
 *
 * ASC + ops (2026-08-18, process 581467e1 / later d4299bec): there is no Alpaca
 * sidecar.  Paper / Roth are REST `alpaca`.  alpaca-broker was 500/500 ok this
 * process, but 191/500 calls were ≥6s (min 97ms / avg ~3085ms / max 14416ms).
 * Latest ~4:40pm CT 98–413ms ok; ~30s earlier several ok at 6570–6600ms — the
 * SDK finished AFTER the 6s `withDeadline` abort.  Same window also aborted
 * portfolio/positions/orders at 8s and getEquityQuotes at 6s.  `ftsMirrorSlice`
 * held the same event loop 6–12s.  First wait is above the live 14.4s max.
 * A 401 / credential throw still fails immediately (no retry).
 */

export const GET_ACCOUNTS_FIRST_MS = 16_000;
export const GET_ACCOUNTS_RETRY_MS = 8_000;
export const PORTFOLIO_BUNDLE_FIRST_MS = 16_000;
export const PORTFOLIO_BUNDLE_RETRY_MS = 8_000;
export const ALPACA_ACCOUNT_READ_FIRST_MS = 16_000;
export const ALPACA_ACCOUNT_READ_RETRY_MS = 8_000;
export const ALPACA_MCP_FETCH_MS = 8_000;

/** Live first-wait / retry for Alpaca REST `getAccount`.  Read at call time so tests can
 *  mock a short budget without changing the 16s production wait. */
export function alpacaAccountReadBudgetMs(): { firstMs: number; retryMs: number } {
  return { firstMs: ALPACA_ACCOUNT_READ_FIRST_MS, retryMs: ALPACA_ACCOUNT_READ_RETRY_MS };
}
/** Same in-process broker lane as getAccounts.  Live 6s / 8s withDeadline races. */
export const EQUITY_QUOTES_MS = 16_000;
export const OPTION_POSITIONS_MS = 16_000;

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
