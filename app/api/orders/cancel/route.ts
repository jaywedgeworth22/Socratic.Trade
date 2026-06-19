import { audit, getPolicy } from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { orderId } = await request.json();
  const userId = resolveRequestUserId(request);
  const policy = getPolicy(userId);
  if (!policy.accountNumber) return new NextResponse("No selected account.", { status: 400 });
  if (!orderId) return new NextResponse("orderId is required.", { status: 400 });
  const result = await getBrokerGateway(policy, userId).cancelEquityOrder(policy.accountNumber, String(orderId));
  audit("order_cancel", { accountNumber: policy.accountNumber, orderId, result }, userId);
  return NextResponse.json(result);
}
