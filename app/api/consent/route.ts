import { NextResponse } from "next/server";
import { DATA_POOL_CONSENT_VERSION, getDataPoolConsent, setDataPoolConsent } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

// Shared market-data pool consent. The UI gates broker-keyed/MCP data features behind acceptance.
// Scope is GENERAL market data only — personal account data is never pooled (see docs/data-pool-consent.md).
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const consent = getDataPoolConsent(userId);
  // A recorded DECLINE resolves the gate too: any answer at the current consent version stands
  // until a version bump re-asks. (The never-answered default is version 0; setDataPoolConsent
  // always stamps the current version, for accepts and declines alike.) Actual pooling remains
  // gated on hasDataPoolConsent(), which requires an explicit accept — declining only stops the
  // blocking dialog from re-appearing on every console load.
  return NextResponse.json({ ...consent, currentVersion: DATA_POOL_CONSENT_VERSION, needsConsent: !((consent.version ?? 0) >= DATA_POOL_CONSENT_VERSION) });
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
