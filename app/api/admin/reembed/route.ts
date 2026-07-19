import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import { operationLeaseBusyResponse } from "@/lib/operation-guard-response";
import {
  CORPUS_REEMBED_DOC_TYPES,
  getCorpusReembedProgress,
  purgeLegacyEmbeddingSpace,
  runCorpusReembedDryRun,
  startCorpusReembedRun,
  type CorpusReembedDocType
} from "@/lib/rag/corpus-reembed";

export const dynamic = "force-dynamic";

// Corpus re-embed admin/operator route: the retrieval-recovery step that must run once, shortly
// after the active embedding model flips away from Voyage (e.g. to bge-m3) — see
// docs/rollouts/2026-07-18-corpus-reembed.md. Every embed goes through the existing storeDocument/
// storeContexts pipeline (budget fuses, batch pacing, ledger receipts all apply automatically);
// this route only triggers/reports the run.
//
// Admin-gated via the shared requireAdmin gate (requireTokenInProd: true — same cost/side-effecting
// posture as /api/admin/reindex-10k, since a real run spends the Voyage/bge + Pinecone budget).
//
// POST { docTypes?, symbols?, dryRun? } — kicks an async run. Real runs (dryRun !== true) are
// fire-and-forget: the response returns immediately once the durable RAG_REINDEX lease is
// acquired, and the run itself keeps going in the background with progress persisted for GET
// polling. A second POST while one is already running gets a "busy" response via that same lease
// (shared with refreshFilingBodies/reconcileManagedVectorRecords, so this never races scheduled
// ingest or an operator-triggered 10-K backfill either). dryRun: true is awaited synchronously and
// returns counts directly in the response — no embedding occurs.
//
// POST { action: "purge-legacy", confirm: "purge-voyage-vectors" } — separate, explicit,
// never-automatic action: deletes vectors from an OLDER embedding space (scoped to the docTypes'
// local receipts), and refuses unless a corpus-reembed run has already reported "completed" for
// every covered docType under the CURRENT active embedding space.
//
// GET — progress/watermarks/per-docType counts (embedded, skipped/reused, failed, budget-deferred)
// plus the current active embed model/revision, so the operator can see which space is being
// filled.
export async function GET(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;
  const progress = getCorpusReembedProgress();
  return NextResponse.json({ ok: true, ...progress });
}

function parseDocTypes(raw: unknown): CorpusReembedDocType[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const known = new Set<string>(CORPUS_REEMBED_DOC_TYPES);
  const filtered = raw.filter((v): v is CorpusReembedDocType => typeof v === "string" && known.has(v));
  return filtered.length > 0 ? filtered : undefined;
}

function parseSymbols(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

export async function POST(request: Request) {
  const denied = requireAdmin(request, { requireTokenInProd: true });
  if (denied) return denied;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // no body / not JSON — treated as "run everything, no filters"
  }

  if (body?.action === "purge-legacy") {
    const confirm = typeof body.confirm === "string" ? body.confirm : "";
    const docTypes = parseDocTypes(body.docTypes);
    const dryRun = body.dryRun === true;
    const guarded = await purgeLegacyEmbeddingSpace({ docTypes, confirm, dryRun });
    if (!guarded.acquired) return operationLeaseBusyResponse("corpus-reembed-purge", guarded.busy!);
    const result = guarded.result!;
    return NextResponse.json({ action: "purge-legacy", ...result }, { status: result.ok ? 200 : 409 });
  }

  const docTypes = parseDocTypes(body.docTypes);
  const symbols = parseSymbols(body.symbols);
  const maxTexts = Number.isFinite(Number(body.maxTexts)) && Number(body.maxTexts) > 0
    ? Math.floor(Number(body.maxTexts))
    : undefined;
  const dryRun = body.dryRun === true;

  if (dryRun) {
    const guarded = await runCorpusReembedDryRun({ docTypes, symbols, maxTexts });
    if (!guarded.acquired) return operationLeaseBusyResponse("corpus-reembed-dry-run", guarded.busy!);
    return NextResponse.json({ ok: true, dryRun: true, result: guarded.result });
  }

  const started = startCorpusReembedRun({ docTypes, symbols, maxTexts });
  if (!started.acquired) return operationLeaseBusyResponse("corpus-reembed", started.busy!);
  return NextResponse.json({ ok: true, started: true, docTypes: docTypes ?? [...CORPUS_REEMBED_DOC_TYPES], symbols });
}
