import { getPolicy, setPolicy } from "@/lib/db";
import { getRobinhoodGateway } from "@/lib/robinhood";
import { NextResponse } from "next/server";

export async function POST() {
  const policy = getPolicy();
  if (!policy.accountNumber) return new NextResponse("Select an account before enabling autonomy.", { status: 400 });
  if (policy.universe === "custom" && policy.allowlist.length === 0) return new NextResponse("Configure an allowlist before enabling autonomy.", { status: 400 });
  const account = (await getRobinhoodGateway().getAccounts()).find((item) => item.accountNumber === policy.accountNumber);
  if (!account) return new NextResponse("Selected account is not available.", { status: 400 });
  if (!account.agenticAllowed) return new NextResponse("Selected account is not agentic_allowed.", { status: 400 });
  const next = { ...policy, enabled: true, killSwitch: false };
  setPolicy(next);
  return NextResponse.json(next);
}
