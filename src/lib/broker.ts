import type { BrokerGateway, EquityOrderInput, ExecutedOrder, TradingPolicy } from "./types";
import { getRobinhoodGateway, getTestGateway } from "./robinhood";
import { getAlpacaGateway } from "./alpaca";
import { getActiveConnectedAccount, getConnectedAccount } from "./db";
import { deriveExecutionState } from "./execution-mode";
import { assertLivePreflight } from "./preflight-live-guard";

function resolveGateway(policy: TradingPolicy, userId: string): BrokerGateway {
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") {
    return getAlpacaGateway(userId, policy.connectedAccountId);
  }
  if (policy.activeBroker === "robinhood") {
    return getRobinhoodGateway(userId);
  }
  // "test", undefined, or any unrecognized value → safe local sim.
  return getTestGateway(userId);
}

/**
 * Wrap a gateway so both mutating broker calls — `placeEquityOrder` AND `cancelEquityOrder` — run the
 * default-off live pre-flight guard first. This is the SINGLE choke point every real-order path flows
 * through — the strategy loop, approval path, synthetic stops, broker protective stops, order
 * replacement, and any future caller — so real capital / broker state is never touched unless
 * `ALLOW_LIVE_TRADING` is set AND the run is genuinely out of paper mode.
 *
 * Guarding the CANCEL too is essential for cancel-then-place workflows (order replacement,
 * protective-stop reconcile): if only the place were guarded, the live cancel would already have
 * executed before the place threw, leaving the order cancelled with no replacement / an unprotected
 * position. Blocking the cancel makes the whole operation fail with NO side effects.
 *
 * No-op in Test/paper. Execution state is derived lazily (only when a mutating call actually runs) so
 * read-only gateway uses pay no extra DB cost. A Proxy (not mutation) keeps the underlying gateway
 * untouched, so re-resolving the gateway can never double-wrap it.
 */
function withLivePreflight(gateway: BrokerGateway, policy: TradingPolicy, userId: string): BrokerGateway {
  // Shared lazy pre-flight — resolves the active account + execution state only when a mutating call
  // fires, then asserts. Throws (→ rejected promise via the async wrappers) on an unauthorized live op.
  const preflight = (order?: { symbol?: string; side?: string }): void => {
    const activeAccount =
      (policy.connectedAccountId ? getConnectedAccount(policy.connectedAccountId, userId) : undefined) ??
      getActiveConnectedAccount(userId);
    const executionState = deriveExecutionState(policy, activeAccount);
    assertLivePreflight({
      mode: executionState.mode,
      usesLocalSimulation: executionState.usesLocalSimulation,
      paperMode: policy.paperMode,
      symbol: order?.symbol,
      side: order?.side
    });
  };
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      // async so a guard failure becomes a REJECTED promise (correct async contract) rather than a
      // synchronous throw, matching how every caller `await`s these.
      if (prop === "placeEquityOrder") {
        return async (input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> => {
          preflight({ symbol: input.symbol, side: input.side });
          return target.placeEquityOrder(input);
        };
      }
      if (prop === "cancelEquityOrder") {
        return async (accountNumber: string, orderId: string): Promise<ExecutedOrder> => {
          preflight();
          return target.cancelEquityOrder(accountNumber, orderId);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

export function getBrokerGateway(policy: TradingPolicy, userId: string = "local"): BrokerGateway {
  return withLivePreflight(resolveGateway(policy, userId), policy, userId);
}
