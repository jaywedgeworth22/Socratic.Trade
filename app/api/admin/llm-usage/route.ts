import { NextResponse } from "next/server";
import { describeUsageKey, getLlmUsageSummary } from "@/lib/llm-usage";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

// Admin/diagnostic route: per-user LLM usage + cost, grouped by (user, provider, key source).
//
// Query params:
//   sinceDays         Window in days (default 30)
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const sinceDays = Number(url.searchParams.get("sinceDays")) || 30;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60_000).toISOString();

  // Enrich each per-key row with a human-readable label + masked key resolved from the live key
  // store — so the per-key view isn't just an opaque fingerprint. Null when the key is detached.
  const rows = getLlmUsageSummary({ sinceIso }).map((r) => {
    const key = describeUsageKey(r);
    return { ...r, keyLabel: key?.label ?? null, keyLast4: key?.last4 ?? null, keyMasked: key?.masked ?? null };
  });

  return NextResponse.json({
    sinceDays,
    totalCostUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    rows
  });
}
