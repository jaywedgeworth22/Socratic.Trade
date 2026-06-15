import { getPolicy } from "@/lib/db";
import { getRobinhoodGateway } from "@/lib/robinhood";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const accountNumber = getPolicy().accountNumber;
  if (!accountNumber) return new NextResponse("No selected account.", { status: 400 });
  return NextResponse.json(await getRobinhoodGateway().getEquityOrders(accountNumber));
}
