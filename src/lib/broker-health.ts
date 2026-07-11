import { countRecentAuditEvents } from "./db-learning";
import { ExecutionAccount, HealthSignals } from "./execution-mode";
import { accountEquity } from "./risk-breaker";
import { BrokerGateway, BrokerageAccount } from "./types";

/**
 * Validates whether the broker connection is currently healthy and the account is ready for trading.
 * Checks connectivity, account status, and recent error rates to prevent the agent from burning
 * LLM tokens and failing repeatedly if the broker is unreachable or the account is suspended/broke.
 */
export async function checkBrokerHealth(
  userId: string,
  account: ExecutionAccount,
  brokerGateway?: BrokerGateway
): Promise<HealthSignals> {
  // If no gateway is provided, we can't check broker-side health.
  // This typically happens if the account isn't meant to submit orders (e.g. read-only mode).
  if (!brokerGateway) {
    return { isHealthy: true };
  }

  try {
    const [accounts, portfolio] = await Promise.all([
      brokerGateway.getAccounts(),
      brokerGateway.getPortfolio(account.accountNumber ?? "")
    ]);

    const activeBrokerAccount = accounts.find((a: BrokerageAccount) => a.accountNumber === account.accountNumber);
    if (!activeBrokerAccount) {
      return { isHealthy: false, reason: "Account not found on broker" };
    }

    if (!activeBrokerAccount.agenticAllowed) {
      return { isHealthy: false, reason: "Account is not marked agenticAllowed by the broker" };
    }

    // Minimum notional check to prevent burning tokens when there's no money.
    // E.g., Robinhood requires $1 minimum for fractional shares.
    const equity = accountEquity(portfolio);
    if (equity < 5.0) {
      return { isHealthy: false, reason: `Account equity (${equity}) is too low to trade` };
    }

    // Check recent error rate: if there are >= 3 order_placement_uncertain errors in the last 15 mins,
    // the broker is likely having transient issues.
    const recentErrors = countRecentAuditEvents("order_placement_uncertain", account.id, 15, userId);
    if (recentErrors >= 3) {
      return { isHealthy: false, reason: `Elevated error rate: ${recentErrors} order placement uncertainties in the last 15 minutes` };
    }

    return { isHealthy: true };
  } catch (err) {
    return { isHealthy: false, reason: `Broker connectivity failure: ${err instanceof Error ? err.message : String(err)}` };
  }
}
