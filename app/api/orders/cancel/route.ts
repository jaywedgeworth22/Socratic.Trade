import { peekBrokerMutationLease } from "@/lib/account-mutation";
import { describeCancelDustRisk, shouldAlertCancelDustRisk } from "@/lib/broker-minimum-guard";
import { audit, getPolicy } from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { emitDashboardEvent } from "@/lib/events";
import { normalizeSymbol } from "@/lib/money";
import { sendNotification } from "@/lib/notifications";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import type { BrokerGateway, TradingPolicy } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Best-effort cancel-dust advisory (r2 lesson: freqtrade). Fetches the resting order + position
 * so `describeCancelDustRisk` can warn when cancelling a partially-filled entry would strand the
 * already-filled shares below the broker's minimum order size. Never throws: a lookup failure
 * here must never delay or block the cancel itself (settings-store fail-open precedent).
 */
async function computeCancelDustWarning(
  gateway: BrokerGateway,
  accountNumber: string,
  orderId: string,
  activeBroker: TradingPolicy["activeBroker"]
): Promise<{ warning: string; symbol: string } | undefined> {
  try {
    const [orders, positions] = await Promise.all([gateway.getEquityOrders(accountNumber), gateway.getEquityPositions(accountNumber)]);
    const order = orders.find((candidate) => candidate.id === orderId);
    if (!order) return undefined;
    const symbol = normalizeSymbol(order.symbol);
    const position = positions.find((candidate) => normalizeSymbol(candidate.symbol) === symbol);
    // Implied current price from the position's own market value — no separate quote fetch, and
    // consistent with how planBrokerMinimumBump derives a price from held position value.
    const currentPrice = position && position.quantity !== 0 ? Math.abs(position.marketValue / position.quantity) : undefined;
    const warning = describeCancelDustRisk(
      { side: order.side, quantity: order.quantity, dollarAmount: order.dollarAmount, filledQuantity: order.filledQuantity, averagePrice: order.averagePrice, currentPrice, symbol: order.symbol },
      position?.quantity,
      activeBroker
    );
    return warning ? { warning, symbol } : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request) {
  const { orderId } = await request.json();
  const userId = resolveRequestUserId(request);
  const limited = enforceRateLimit(userId, "orders/cancel", RATE_LIMITS.orders);
  if (limited) return limited;
  const policy = getPolicy(userId);
  if (!policy.accountNumber) return new NextResponse("No selected account.", { status: 400 });
  if (!orderId) return new NextResponse("orderId is required.", { status: 400 });
  // §7 slice 3 cancel doctrine: a standalone cancel is the operator's emergency lever and NEVER
  // waits behind the account mutation lease — it can only free buying power. If it fires while
  // another sequence holds the lease, receipt the interleave so it is visible, then proceed.
  const heldBy = peekBrokerMutationLease(userId, policy.accountNumber, policy.connectedAccountId);
  if (heldBy) {
    audit(
      "broker_mutation_cancel_during_lease",
      { accountNumber: policy.accountNumber, orderId: String(orderId), activeOperation: heldBy.operation },
      userId,
      policy.connectedAccountId
    );
  }
  const gateway = getBrokerGateway(policy, userId);
  const dust = await computeCancelDustWarning(gateway, policy.accountNumber, String(orderId), policy.activeBroker);
  if (dust) {
    audit(
      "order_cancel_dust_risk",
      { accountNumber: policy.accountNumber, orderId: String(orderId), symbol: dust.symbol, warning: dust.warning },
      userId,
      policy.connectedAccountId
    );
  }
  // ADVISORY ONLY — the cancel always executes regardless of `dust`. Cancel is the operator's
  // emergency lever and must never be blocked or delayed by this warning.
  const result = await gateway.cancelEquityOrder(policy.accountNumber, String(orderId));
  audit("order_cancel", { accountNumber: policy.accountNumber, orderId, result }, userId);
  emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { orderId: String(orderId), action: "cancel" } });
  if (dust && shouldAlertCancelDustRisk(userId, policy.accountNumber, dust.symbol)) {
    await sendNotification(
      {
        type: "risk_advisory",
        title: `${dust.symbol} cancel may leave dust below the broker minimum`,
        payload: { reason: dust.warning, orderId: String(orderId), symbol: dust.symbol, accountNumber: policy.accountNumber }
      },
      { policy, userId }
    );
  }
  return NextResponse.json({ ...result, ...(dust ? { dustWarning: dust.warning } : {}) });
}
