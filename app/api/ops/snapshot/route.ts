import { authorizeOpsRequest } from "@/lib/ops-auth";
import { buildOpsSnapshot } from "@/lib/ops-snapshot";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Token-gated operational snapshot for remote diagnostics (Cursor cloud agent, curl, uptime
 * monitors). Does not require an OAuth session — middleware treats `/api/ops/*` as public and
 * this handler enforces `OPS_DIAGNOSTIC_TOKEN` (or legacy `ADMIN_REINDEX_TOKEN`).
 *
 * Headers: `x-ops-token: <secret>` OR `Authorization: Bearer <secret>`
 */
export async function GET(request: Request) {
  if (!authorizeOpsRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Set OPS_DIAGNOSTIC_TOKEN and pass x-ops-token or Authorization: Bearer." },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const runsPerUser = Math.min(50, Math.max(1, Number(url.searchParams.get("runs")) || 20));
  const auditPerUser = Math.min(100, Math.max(1, Number(url.searchParams.get("audit")) || 40));

  return NextResponse.json({
    ok: true,
    ...buildOpsSnapshot({ runsPerUser, auditPerUser })
  });
}
