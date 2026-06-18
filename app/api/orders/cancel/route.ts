import { audit, getPolicy } from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const { orderId } = await request.json();
  const policy = getPolicy();
  if (!policy.accountNumber) return new NextResponse("No selected account.", { status: 400 });
  if (!orderId) return new NextResponse("orderId is required.", { status: 400 });
  const result = await getBrokerGateway(policy).cancelEquityOrder(policy.accountNumber, String(orderId));
  audit("order_cancel", { accountNumber: policy.accountNumber, orderId, result });
  return NextResponse.json(result);
}
