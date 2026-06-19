import { NextResponse } from "next/server";
import { getEightKDataset, reindexEightKDataset } from "@/lib/web-sources/sec8k";
import { getVectorStoreStats } from "@/lib/vector-db";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

// Admin/diagnostic route to (re)embed the persisted SEC 8-K dataset into Pinecone and report
// vector-store stats. This backfills the index after the Voyage-billing 429 that left it empty.
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
  const dataset = getEightKDataset();
  const stats = await getVectorStoreStats(resolveRequestUserId(request));
  return NextResponse.json({
    ok: true,
    datasetRecordCount: dataset?.recordCount ?? 0,
    datasetFetchedAt: dataset?.fetchedAt,
    vectorStore: stats
  });
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not authorized in production without ADMIN_REINDEX_TOKEN." }, { status: 403 });
  }
  const userId = resolveRequestUserId(request);
  let limit = Number.POSITIVE_INFINITY;
  try {
    const body = (await request.json()) as { limit?: number };
    if (body && Number.isFinite(Number(body.limit))) limit = Number(body.limit);
  } catch {
    // no body / not JSON → reindex the whole dataset
  }
  const before = await getVectorStoreStats(userId);
  const result = await reindexEightKDataset(userId, limit);
  const after = await getVectorStoreStats(userId);
  return NextResponse.json({
    ok: !result.error,
    result,
    vectorStoreBefore: before,
    vectorStoreAfter: after
  });
}
