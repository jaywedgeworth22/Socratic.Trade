import { NextResponse } from "next/server";
import { buildFactorObservations, computeFactorICs, deriveWeightsFromICs } from "@/lib/backtest";
import { getPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

// Admin/diagnostic route: validate the scan's factor weights against realized forward returns.
// Computes each sub-score's information coefficient (rank correlation vs forward N-day return)
// over the persisted signal_snapshot audits, and returns an IC-derived ScoringWeights SUGGESTION.
// READ-ONLY — it never applies the weights (the auto-tuner's 20-closed-lot gate governs that).
// Gated: only runs outside production, OR when ADMIN_REINDEX_TOKEN matches the x-admin-token header.
function authorized(request: Request): boolean {
  const token = process.env.ADMIN_REINDEX_TOKEN;
  if (token && request.headers.get("x-admin-token") === token) return true;
  return process.env.NODE_ENV !== "production";
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not authorized in production without ADMIN_REINDEX_TOKEN." }, { status: 403 });
  }
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const horizonDays = Number(url.searchParams.get("horizonDays")) || 5;
  const auditLimit = Number(url.searchParams.get("auditLimit")) || 500;

  const observations = await buildFactorObservations(userId, { horizonDays, auditLimit });
  const ics = computeFactorICs(observations);
  const current = getPolicy(userId).scoringWeights;
  const suggestedWeights = deriveWeightsFromICs(ics, current);

  return NextResponse.json({
    ok: true,
    horizonDays,
    observationCount: observations.length,
    informationCoefficients: ics, // [{ factor, ic, n }]
    currentWeights: current ?? null,
    suggestedWeights, // IC-derived; advisory only, never auto-applied
    note: "Suggestion only. Apply via the strategy tuner, which holds weight shifts to the 20-closed-lot gate."
  });
}
