import type { BrokerGateway, TradingPolicy } from "./types";
import { getRobinhoodGateway } from "./robinhood";
import { getAlpacaGateway } from "./alpaca";

export function getBrokerGateway(policy: TradingPolicy, userId: string = "local"): BrokerGateway {
  if (policy.activeBroker === "alpaca") {
    return getAlpacaGateway(userId);
  }
  
  // Default to Robinhood if missing or set to robinhood
  return getRobinhoodGateway();
}
