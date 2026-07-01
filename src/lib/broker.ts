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
 * Wrap a gateway so `placeEquityOrder` runs the default-off live pre-flight guard first. This is the
 * SINGLE choke point every real-order PLACEMENT path flows through — the strategy loop, approval path,
 * synthetic stops, broker protective stops, order replacement, and any future caller — so real capital
 * is never committed unless `ALLOW_LIVE_TRADING` is set AND the run is genuinely out of paper mode.
 *
 * `cancelEquityOrder` is deliberately NOT guarded here: cancelling is RISK-REDUCING, and an operator
 * who disables live trading in an emergency must still be able to cancel outstanding live orders /
 * stale protective stops (manual `/api/orders/cancel`, cancel-on-close cleanup, etc.). The narrow
 * cancel-THEN-place workflows (order replacement, protective-stop reconcile) instead run the pre-flight
 * BEFORE their own cancel phase (see `livePreflightBlocks`), so they fail atomically with no orphaned
 * cancel — without blocking standalone cancels.
 *
 * No-op in Test/paper. Execution state is derived lazily (only when a placement actually runs) so
 * read-only gateway uses pay no extra DB cost. A Proxy (not mutation) keeps the underlying gateway
 * untouched, so re-resolving the gateway can never double-wrap it.
 */
function withLivePreflight(gateway: BrokerGateway, policy: TradingPolicy, userId: string): BrokerGateway {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      if (prop === "placeEquityOrder") {
        // async so a guard failure becomes a REJECTED promise (correct async contract) rather than a
        // synchronous throw, matching how every caller `await`s placeEquityOrder.
        return async (input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> => {
          const activeAccount =
            (policy.connectedAccountId ? getConnectedAccount(policy.connectedAccountId, userId) : undefined) ??
            getActiveConnectedAccount(userId);
          const executionState = deriveExecutionState(policy, activeAccount);
          assertLivePreflight({
            mode: executionState.mode,
            usesLocalSimulation: executionState.usesLocalSimulation,
            paperMode: policy.paperMode,
            symbol: input.symbol,
            side: input.side
          });
          return target.placeEquityOrder(input);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

export function getBrokerGateway(policy: TradingPolicy, userId: string = "local"): BrokerGateway {
  return withLivePreflight(resolveGateway(policy, userId), policy, userId);
}
