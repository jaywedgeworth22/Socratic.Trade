import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { congressTradeToken, isCongressShareAutoEnabled, runCongressDailyShare } from "@/lib/congress-share";

export const dynamic = "force-dynamic";

// Admin/ops route to manually push company refs + daily closes + the S&P-500 series to congress.trade
// (App A). Admin-gated (ADMIN_USER_EMAILS / primary operator, x-admin-token, or non-prod). Requires
// CONGRESS_TRADE_TOKEN to be configured; bypasses the once-per-day cadence (force) so ops can test.
//
// Body (all optional):
//   { symbols?: string[] }      — share only those tickers (targeted test; does NOT advance the daily marker)
//   { fullHistory?: boolean }   — deep-history backfill: send each symbol's FULL series (uncapped, still
//                                 chunked) so App A can compute performance back to old trade dates.
// Otherwise shares the monitored universe (recent-capped).
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  if (!congressTradeToken()) {
    return NextResponse.json(
      { ok: false, error: "CONGRESS_TRADE_TOKEN is not configured (server env)." },
      { status: 400 }
    );
  }

  let symbols: string[] | undefined;
  let fullHistory = false;
  try {
    const body = (await request.json()) as { symbols?: unknown; fullHistory?: unknown };
    if (Array.isArray(body?.symbols)) {
      symbols = body.symbols.map((s) => String(s)).filter(Boolean);
    }
    fullHistory = body?.fullHistory === true;
  } catch {
    // no body → share the monitored universe
  }

  const summary = await runCongressDailyShare({ now: Date.now(), force: true, symbols, fullHistory });
  return NextResponse.json({ autoEnabled: isCongressShareAutoEnabled(), ...summary });
}
