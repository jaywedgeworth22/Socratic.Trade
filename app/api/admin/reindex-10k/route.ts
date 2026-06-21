import { NextResponse } from "next/server";
import { listIngestedAccessions } from "@/lib/db";
import { refreshFilingBodies } from "@/lib/web-sources/sec-filings";
import { getVectorStoreStats } from "@/lib/vector-db";

export const dynamic = "force-dynamic";

// Admin/operator route to trigger a full 10-K/10-Q backfill once a paid Voyage key is set.
// Gate: only runs outside production, OR when ADMIN_REINDEX_TOKEN matches x-admin-token header.
// Returns { indexed, skipped, errors } so the operator can confirm a successful backfill.
function authorized(request: Request): boolean {
  const token = process.env.ADMIN_REINDEX_TOKEN;
  if (token && request.headers.get("x-admin-token") === token) return true;
  return process.env.NODE_ENV !== "production";
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not authorized in production without ADMIN_REINDEX_TOKEN." }, { status: 403 });
  }
  const recent = listIngestedAccessions(50);
  const stats = await getVectorStoreStats();
  return NextResponse.json({ ok: true, ingestedAccessions: recent, vectorStore: stats });
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not authorized in production without ADMIN_REINDEX_TOKEN." }, { status: 403 });
  }

  let symbols: string[] = [];
  let limit = Number.POSITIVE_INFINITY;
  try {
    const body = (await request.json()) as { symbols?: string[]; limit?: number };
    if (Array.isArray(body?.symbols)) symbols = body.symbols.filter((s) => typeof s === "string" && s.length > 0);
    if (Number.isFinite(Number(body?.limit))) limit = Number(body.limit);
  } catch {
    // no body / not JSON → empty symbols (will return error)
  }

  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: "Provide { symbols: string[], limit?: number } in the request body." }, { status: 400 });
  }

  const result = await refreshFilingBodies(symbols, Date.now(), limit);
  const stats = await getVectorStoreStats();
  return NextResponse.json({ ok: result.errors.length === 0, result, vectorStore: stats });
}
