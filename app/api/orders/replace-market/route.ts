import { getBrokerGateway } from "@/lib/broker";
import { emitDashboardEvent } from "@/lib/events";
import {
  MarketReplaceConfirmationError,
  MarketReplacePreconditionError,
  replaceStaleLimitOrderWithMarket,
  type MarketReplaceConfirmation
} from "@/lib/order-replacement";
import { STOPPED_PROPOSAL_ACTION_MESSAGE, isProposalActionStopped } from "@/lib/proposal-actions";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getActiveConnectedAccount, getPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      orderId?: unknown;
      liveConfirmation?: MarketReplaceConfirmation;
      userId?: unknown;
    };
    const userId = resolveRequestUserId(request, body);
    const limited = enforceRateLimit(userId, "orders/replace-market", RATE_LIMITS.orders);
    if (limited) return limited;

    const policy = getPolicy(userId);
    if (isProposalActionStopped(policy)) {
      return NextResponse.json({ error: "system_stopped", message: STOPPED_PROPOSAL_ACTION_MESSAGE }, { status: 409 });
    }
    if (!policy.accountNumber) return new NextResponse("No selected account.", { status: 400 });
    const orderId = String(body.orderId ?? "").trim();
    if (!orderId) return new NextResponse("orderId is required.", { status: 400 });

    const result = await replaceStaleLimitOrderWithMarket({
      userId,
      policy: { ...policy, accountNumber: policy.accountNumber },
      activeAccount: getActiveConnectedAccount(userId),
      gateway: getBrokerGateway(policy, userId),
      orderId,
      liveConfirmation: body.liveConfirmation
    });

    emitDashboardEvent({
      type: "order",
      userId,
      at: new Date().toISOString(),
      detail: { orderId, action: "replace_market", replacementOrderId: result.replacementOrderId }
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MarketReplaceConfirmationError) {
      return NextResponse.json(
        { error: "live_confirmation_required", reasons: error.reasons, expectedText: error.expectedText },
        { status: 409 }
      );
    }
    if (error instanceof MarketReplacePreconditionError) {
      return NextResponse.json({ error: "replace_precondition_failed", message: error.message }, { status: error.status });
    }
    return new NextResponse(error instanceof Error ? error.message : "Failed to replace order.", { status: 400 });
  }
}
