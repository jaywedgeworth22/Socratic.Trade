import { NextResponse } from "next/server";
import { DATA_POOL_CONSENT_VERSION, getDataPoolConsent, setDataPoolConsent } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

// Shared market-data pool consent. The UI gates broker-keyed/MCP data features behind acceptance.
// Scope is GENERAL market data only — personal account data is never pooled (see docs/data-pool-consent.md).
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const consent = getDataPoolConsent(userId);
  return NextResponse.json({ ...consent, currentVersion: DATA_POOL_CONSENT_VERSION, needsConsent: !(consent.accepted && consent.version >= DATA_POOL_CONSENT_VERSION) });
}

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  let accepted = false;
  try {
    const body = (await request.json()) as { accepted?: boolean };
    accepted = body?.accepted === true;
  } catch {
    /* default decline */
  }
  const record = setDataPoolConsent(userId, accepted);
  return NextResponse.json({ ...record, currentVersion: DATA_POOL_CONSENT_VERSION });
}
