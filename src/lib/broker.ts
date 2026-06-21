import type { BrokerGateway, TradingPolicy } from "./types";
import { getRobinhoodGateway, getTestGateway } from "./robinhood";
import { getAlpacaGateway } from "./alpaca";

export function getBrokerGateway(policy: TradingPolicy, userId: string = "local"): BrokerGateway {
  if (policy.activeBroker === "alpaca" || policy.activeBroker === "alpaca-mcp") {
    return getAlpacaGateway(userId);
  }
  if (policy.activeBroker === "test") {
    // Local Test broker: real quotes, simulated fills, no real broker connection.
    return getTestGateway();
  }
  // Robinhood (MCP-only) is the remaining broker.
  return getRobinhoodGateway();
}
