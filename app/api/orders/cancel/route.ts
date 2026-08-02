import { peekBrokerMutationLease } from "@/lib/account-mutation";
import { audit, getPolicy } from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { emitDashboardEvent } from "@/lib/events";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

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
  const result = await getBrokerGateway(policy, userId).cancelEquityOrder(policy.accountNumber, String(orderId));
  audit("order_cancel", { accountNumber: policy.accountNumber, orderId, result }, userId);
  emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { orderId: String(orderId), action: "cancel" } });
  return NextResponse.json(result);
}
