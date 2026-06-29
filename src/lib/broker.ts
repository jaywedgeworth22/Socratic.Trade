import type { BrokerGateway, TradingPolicy } from "./types";
import { getRobinhoodGateway, getTestGateway } from "./robinhood";
import { getAlpacaGateway } from "./alpaca";

export function getBrokerGateway(policy: TradingPolicy, userId: string = "local"): BrokerGateway {
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") {
    return getAlpacaGateway(userId, policy.connectedAccountId);
  }
  if (policy.activeBroker === "robinhood") {
    return getRobinhoodGateway(userId);
  }
  // "test", undefined, or any unrecognized value → safe local sim.
  return getTestGateway(userId);
}
