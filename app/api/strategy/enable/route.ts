import { getPolicy, setPolicy } from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const policy = getPolicy(userId);
  if (!policy.accountNumber) return new NextResponse("Select an account before enabling autonomy.", { status: 400 });
  if (policy.universe === "custom" && policy.allowlist.length === 0) return new NextResponse("Configure an allowlist before enabling autonomy.", { status: 400 });
  const account = (await getBrokerGateway(policy, userId).getAccounts()).find((item) => item.accountNumber === policy.accountNumber);
  if (!account) return new NextResponse("Selected account is not available.", { status: 400 });
  if (!account.agenticAllowed) return new NextResponse("Selected account is not agentic_allowed.", { status: 400 });
  const next = { ...policy, enabled: true, killSwitch: false };
  setPolicy(next, userId);
  return NextResponse.json(next);
}
