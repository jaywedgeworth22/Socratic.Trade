import { NextResponse } from "next/server";
import { DATA_POOL_CONSENT_VERSION, getDataPoolConsent, needsDataPoolConsent, setDataPoolConsent } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

// Mandatory shared market-data pool (owner 2026-08-17).  Unset users do not
// silently share.  Accept is required to use the app; decline does not resolve
// the gate.  Scope is GENERAL market data only — personal account data is never
// pooled (see docs/data-pool-consent.md).
export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const consent = getDataPoolConsent(userId);
  return NextResponse.json({
    ...consent,
    currentVersion: DATA_POOL_CONSENT_VERSION,
    needsConsent: needsDataPoolConsent(userId),
    mandatory: true
  });
}

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  let accepted = false;
  try {
    const body = (await request.json()) as { accepted?: boolean };
    accepted = body?.accepted === true;
  } catch {
    accepted = false;
  }
  if (!accepted) {
    return NextResponse.json(
      { error: "Sharing general market data is required to use the app." },
      { status: 400 }
    );
  }
  const record = setDataPoolConsent(userId, true);
  return NextResponse.json({
    ...record,
    currentVersion: DATA_POOL_CONSENT_VERSION,
    needsConsent: false,
    mandatory: true
  });
}
