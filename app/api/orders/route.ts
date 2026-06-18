import { getPolicy } from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const policy = getPolicy();
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return new NextResponse("No selected account.", { status: 400 });
  return NextResponse.json(await getBrokerGateway(policy).getEquityOrders(accountNumber));
}
