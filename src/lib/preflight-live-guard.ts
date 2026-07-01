// Pre-flight live-order guard.
//
// A last-line, default-SAFE assertion that runs immediately BEFORE the strategy loop hands an order
// to a real (production-broker) placement call. The per-trade policy gate and the account circuit
// breaker bound risk on the assumption that the code paths themselves are wired correctly; this
// guard defends against the code path *itself* being misconfigured — e.g. a run that has somehow
// reached the live-placement branch while the operator never explicitly enabled live trading.
//
// Design contract:
//   - In Test/paper mode (`usesLocalSimulation === true`, i.e. mode "test/local" / paperMode, or any
//     broker *paper* sandbox) this is a hard NO-OP: `assertLivePreflight` returns immediately. It can
//     never block a paper/simulated run, so wiring it into the hot path is byte-safe for the default
//     (paper) configuration.
//   - On the real-capital path (`mode === "broker/live"`, real money) it REFUSES to proceed unless
//     BOTH invariants hold:
//       1. `policy.paperMode === false` — the account is genuinely out of paper mode. (A live-mode
//          state with `paperMode !== false` is a contradiction and is blocked.)
//       2. Live trading is EXPLICITLY enabled by the operator via the `ALLOW_LIVE_TRADING=true`
//          environment flag (or the caller passes `allowLive: true`). Absent that opt-in, even a
//          correctly-configured live run is blocked — real capital is never touched by default.
//   - It NEVER places, mutates, or enables a trade. It only throws (blocks) or returns (allows).
//
// This module has no I/O and no DB access so it is trivially unit-testable and safe to import
// anywhere in the execution path.

export interface LivePreflightInput {
  /** Execution mode for this run. Only "broker/live" reaches real capital. */
  mode: "test/local" | "broker/paper" | "broker/live";
  /** True for the local simulator and broker paper sandboxes — the no-op case. */
  usesLocalSimulation: boolean;
  /** The run's policy paperMode flag. Must be an explicit `false` on the live path. */
  paperMode: boolean;
  /**
   * Explicit per-call live opt-in. When omitted, the guard falls back to the `ALLOW_LIVE_TRADING`
   * environment flag. Provided mainly so tests don't have to mutate process.env.
   */
  allowLive?: boolean;
  /** Symbol/side for a clearer error message. Optional. */
  symbol?: string;
  side?: string;
}

/** Thrown when the live-order pre-flight assertion fails. Distinct type so callers can catch it. */
export class LivePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LivePreflightError";
  }
}

/** Whether the operator has explicitly enabled live trading via env. Default OFF. */
export function liveTradingEnabledByEnv(): boolean {
  return process.env.ALLOW_LIVE_TRADING === "true";
}

/**
 * Assert the invariants that MUST hold before a real (production-broker) order is placed. No-op in
 * Test/paper mode. Throws `LivePreflightError` on the live path when live trading isn't explicitly
 * enabled or the paperMode flag is inconsistent with a live run. Returns normally when it is safe to
 * proceed (or when the path is simulated/paper and the guard does not apply).
 */
export function assertLivePreflight(input: LivePreflightInput): void {
  // No-op for the local simulator and any broker paper sandbox — never blocks a paper/test run.
  if (input.usesLocalSimulation || input.mode !== "broker/live") return;

  const where = input.symbol ? ` for ${input.side ?? "order"} ${input.symbol}` : "";

  // A live execution state must have paperMode explicitly false. Anything else is a contradiction
  // (the code reached the live branch while the policy still claims paper) — fail closed.
  if (input.paperMode !== false) {
    throw new LivePreflightError(
      `Live-order pre-flight BLOCKED${where}: execution mode is broker/live but policy.paperMode is not false ` +
      `(got ${JSON.stringify(input.paperMode)}). Refusing to place a real-capital order on an inconsistent state.`
    );
  }

  // Live trading must be explicitly enabled. Default-off: even a correctly-configured live run is
  // blocked until the operator opts in, so no code path can silently reach real capital.
  const allowLive = input.allowLive ?? liveTradingEnabledByEnv();
  if (!allowLive) {
    throw new LivePreflightError(
      `Live-order pre-flight BLOCKED${where}: real-capital (broker/live) order attempted but live trading is not ` +
      `explicitly enabled. Set ALLOW_LIVE_TRADING=true to permit live order placement. (Paper/Test mode is unaffected.)`
    );
  }
}
