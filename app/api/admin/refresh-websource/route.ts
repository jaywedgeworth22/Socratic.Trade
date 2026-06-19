import { NextResponse } from "next/server";
import { refreshCongress, getCongressDataset } from "@/lib/web-sources/congress";
import { refreshEightK, getEightKDataset } from "@/lib/web-sources/sec8k";

export const dynamic = "force-dynamic";

// Dev/ops route to force a web-source refresh (bypasses TTL/backoff) and report the result.
// Gated to non-production unless ADMIN_REINDEX_TOKEN matches the x-admin-token header.
function authorized(request: Request): boolean {
  const token = process.env.ADMIN_REINDEX_TOKEN;
  if (token && request.headers.get("x-admin-token") === token) return true;
  return process.env.NODE_ENV !== "production";
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not authorized in production without ADMIN_REINDEX_TOKEN." }, { status: 403 });
  }
  let id = "congress";
  try {
    const body = (await request.json()) as { id?: string };
    if (body?.id) id = String(body.id);
  } catch {
    // default to congress
  }

  if (id === "congress") {
    const result = await refreshCongress(Date.now(), true);
    const ds = getCongressDataset();
    const byChamber = (ds?.trades ?? []).reduce<Record<string, number>>((acc, t) => {
      acc[t.chamber] = (acc[t.chamber] ?? 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({ ok: result.ok, id, result, recordCount: ds?.recordCount ?? 0, byChamber, sources: ds?.sources ?? [] });
  }
  if (id === "sec8k") {
    const result = await refreshEightK(Date.now(), true);
    return NextResponse.json({ ok: result.ok, id, result, recordCount: getEightKDataset()?.recordCount ?? 0 });
  }
  return NextResponse.json({ ok: false, error: `Unknown web-source id: ${id} (supported: congress, sec8k)` }, { status: 400 });
}
