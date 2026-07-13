import { NextResponse } from "next/server";
import { listIngestedAccessions } from "@/lib/db";
import { refreshFilingBodies } from "@/lib/web-sources/sec-filings";
import { getVectorStoreStats } from "@/lib/vector-db";
import { requireAdmin } from "@/lib/auth/admin";
import { withAdminOperationGuard } from "@/lib/admin-operation-guard";
import { getOperationLeaseBusy } from "@/lib/operation-lease";
import { operationLeaseBusyResponse } from "@/lib/operation-guard-response";
import { normalizeSymbol } from "@/lib/money";

export const dynamic = "force-dynamic";

// Admin/operator route to trigger a full 10-K/10-Q backfill once a paid Voyage key is set.
// Admin-gated via the shared requireAdmin gate: a middleware-verified primary/allowlisted admin email,
// or a timing-safe x-admin-token match against ADMIN_REINDEX_TOKEN; there is no environment bypass. (A local
// `authorized()` helper compared the token with `===`; migrated to the shared, constant-time gate.)
// Returns { indexed, skipped, errors } so the operator can confirm a successful backfill.

export async function GET(request: Request) {
  // requireTokenInProd: in production the x-admin-token is mandatory. The local fallback is already
  // excluded by provenance, and this stronger gate also rejects a genuinely verified email alone.
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;
  const recent = listIngestedAccessions(50);
  const stats = await getVectorStoreStats();
  return NextResponse.json({ ok: true, ingestedAccessions: recent, vectorStore: stats });
}

export async function POST(request: Request) {
  // requireTokenInProd: in production the x-admin-token is mandatory. The local fallback is already
  // excluded by provenance, and this stronger gate also rejects a genuinely verified email alone.
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;

  let symbols: string[] = [];
  let limit: number | undefined;
  let clearCache = false;
  try {
    const body = (await request.json()) as { symbols?: string[]; limit?: number; clearCache?: boolean };
    if (Array.isArray(body?.symbols)) symbols = [...new Set(body.symbols
      .filter((s) => typeof s === "string" && s.length > 0)
      .map((s) => normalizeSymbol(s)))];
    if (Number.isFinite(Number(body?.limit))) limit = Number(body.limit);
    if (body?.clearCache === true) clearCache = true;
  } catch {
    // no body / not JSON → empty symbols (will return error)
  }

  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: "Provide { symbols: string[], limit?: number, clearCache?: boolean } in the request body." }, { status: 400 });
  }

  return withAdminOperationGuard(request, "reindex-10k", async (operationLeaseClaim) => {
    if (clearCache) {
      const { getDb } = await import("@/lib/db");
      // Scope to 10-K/10-Q accessions only — this endpoint re-indexes those forms via
      // refreshFilingBodies and must not purge 8-K-body or other doc type ledgers.
      const acnPlaceholders = symbols.map(() => "?").join(",");
      getDb().prepare(
        `DELETE FROM ingested_accessions WHERE ticker IN (${acnPlaceholders}) AND (doc_type = '10-K' OR doc_type = '10-Q')`
      ).run(...symbols);

      // Build the canonical (hyphen-free) form of each symbol too.
      // normalizeSymbol keeps hyphens (BRK-B), while canonicalTicker (in rag/chunk.ts) strips them
      // (BRK-B → BRKB) and that is what insertDocumentChunks stores as document_chunks.symbol
      // via storeDocument (src/lib/vector-db.ts:1386, 1436). A DELETE on the hyphenated form alone
      // would miss rows stored under the canonical form.
      const canonicalSymbols = symbols.map((s) => s.replace(/-/g, ""));
      const allChunkSymbols = [...new Set([...symbols, ...canonicalSymbols])];
      const chunkPlaceholders = allChunkSymbols.map(() => "?").join(",");

      // document_chunks is dedup-keyed by content_hash globally. A content hash first recorded
      // under one ticker's filing (e.g. boilerplate shared across issuers) would survive a
      // symbol-scoped DELETE, leaving filterNewDocumentChunks to skip the chunk on reindex even
      // after a full Pinecone reset.  Use a subquery to find ALL content_hashes belonging to the
      // target symbols' SEC-EDGAR chunks, then delete every row with those hashes regardless of
      // the symbol on the individual row.
      // Scope to sec-edgar source (10-K/10-Q chunks); 8-K body chunks use source = 'sec-8k'.
      getDb().prepare(
        `DELETE FROM document_chunks WHERE content_hash IN (
          SELECT content_hash FROM document_chunks WHERE symbol IN (${chunkPlaceholders}) AND source = 'sec-edgar'
        )`
      ).run(...allChunkSymbols);

      console.log(`[reindex-10k] Cleared local RAG metadata cache for ${symbols.length} symbol(s): ${symbols.join(", ")}.`);
    }

    // force: this is the operator explicitly asking for a backfill — it must not silently no-op
    // behind the scheduler's ingest TTL stamp (it did until 2026-07-09, returning {attempted: 0}
    // for up to a week after any scheduler attempt). An explicit `limit` also overrides the
    // free-tier 1-filing cap; omitted, the tier default applies (paid 25 / free 1).
    const result = await refreshFilingBodies(symbols, Date.now(), limit, { force: true, operationLeaseClaim });
    const busy = getOperationLeaseBusy(result);
    if (busy) return operationLeaseBusyResponse("reindex-10k", busy);
    const stats = await getVectorStoreStats();
    return NextResponse.json({ ok: result.errors.length === 0, result, vectorStore: stats, clearedCache: clearCache });
  });
}
