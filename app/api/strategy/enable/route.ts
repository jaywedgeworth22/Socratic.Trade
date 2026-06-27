import { getPolicy, setPolicy } from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { messageFromUnknownError } from "@/lib/recoverable-issue";
import { resolveRequestUserId } from "@/lib/request-user";
import type { BrokerageAccount } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const policy = getPolicy(userId);
  if (!policy.accountNumber) return new NextResponse("Select an account before enabling autonomy.", { status: 400 });
  if (policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0) return new NextResponse("Select at least one base index or additional watchlist symbol before enabling autonomy.", { status: 400 });
  let accounts: BrokerageAccount[];
  try {
    accounts = await getBrokerGateway(policy, userId).getAccounts();
  } catch (error) {
    return new NextResponse(`Selected broker account is not reachable: ${messageFromUnknownError(error)}`, { status: 400 });
  }
  const account = accounts.find((item) => item.accountNumber === policy.accountNumber);
  if (!account) return new NextResponse("Selected account is not available.", { status: 400 });
  if (!account.agenticAllowed) return new NextResponse("Selected account is not agentic_allowed.", { status: 400 });
  const next = { ...policy, systemState: "active" as const };
  setPolicy(next, userId);
  return NextResponse.json(next);
}
