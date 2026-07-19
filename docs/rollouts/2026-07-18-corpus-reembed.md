# 2026-07-18 — Corpus re-embed into the active embedding space (bge-m3 recovery path)

## URGENT — run-me-now sequencing (read this first)

**Production deployed current `main` this morning with the bge-m3 embed flip LIVE, and prod
health shows voyage `ok:false`. That means retrieval is ALREADY running against the bge-m3
embedding space, which is EMPTY until this re-embed runs.** Embedding-space isolation
(`embedSpaceFilterForModel`, PR #1669) is doing exactly what it was designed to do — refusing to
rank bge queries against Voyage vectors — so every dense-retrieval consumer (filings evidence,
episodic experience memory, insider/disclosure context) is degraded to sparse/no-match until the
corpus is backfilled into the new space.

**This branch is the recovery step.** As soon as it lands, the operator sequence is:

```bash
# 1. Optional but recommended: see scope without spending anything
curl -X POST https://socratictrade.com/api/admin/reembed \
  -H "x-admin-token: $ADMIN_REINDEX_TOKEN" -H "content-type: application/json" \
  -d '{"dryRun": true}'

# 2. Kick the real run (fire-and-forget; returns immediately)
curl -X POST https://socratictrade.com/api/admin/reembed \
  -H "x-admin-token: $ADMIN_REINDEX_TOKEN" -H "content-type: application/json" -d '{}'

# 3. Poll progress until every docType shows status "completed"
curl https://socratictrade.com/api/admin/reembed -H "x-admin-token: $ADMIN_REINDEX_TOKEN"
```

Scale expectation: ~8.5k existing vectors in the corpus, so a server-side run is
**minutes-to-hours** under the default daily fuses (`RAG_INGEST_MAX_TEXTS_PER_DAY` 20k,
`RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` 200k — one calendar day of headroom covers the whole
corpus; the pacing knob that actually dominates wall-clock is `VECTOR_EMBED_BATCH_DELAY_MS`). If a
run stops with `stopped-budget`, re-POST after the 24h window rolls — the watermark resumes where
it left off and already-committed content is skipped for free.

**Do NOT purge Voyage vectors yet.** The purge action exists (below) but is deliberately gated on
per-docType completion receipts, and it is never automatic. Leave the old space in place until the
new one is verified filled (it's invisible to bge-m3 queries either way; it costs only storage).

## Summary

New module `src/lib/rag/corpus-reembed.ts` + admin route `app/api/admin/reembed/route.ts`:
re-ingests all locally-held re-embeddable content through the EXISTING `storeDocument`/
`storeContexts` pipeline so it lands in whatever embedding space is currently active
(`activeEmbeddingModel`). Idempotent, resumable (durable per-docType watermarks), serialized
under the shared `RAG_REINDEX` operation lease, and budget-fused exactly like normal ingestion.

Covered docTypes (all rebuilt from the local SQLite DB — zero provider re-fetch):

| docType | Local source | Pipeline | Identity (documentKey) |
| --- | --- | --- | --- |
| `sec-filings` | `document_chunks_fts` (10-K/10-Q chunk text, `source='sec-edgar'`) joined to `sec_filings` for form/dates | `storeDocument` | `<accession>:<content_hash>` |
| `earningscalls-transcripts` | `earningscalls_transcripts.content` | `storeDocument` | `earningscalls:<SYM>:<FY>Q<Q>` (shared `accessionFor`, now exported) |
| `experience-memory` | `fill_events` replayed through `calculatePnl` per connected account (new additive helper `listClosedLotExperienceDocumentsForAccount`) | `storeContexts` (private scope) | account-level watermark; Pinecone id is the stable `exp:<entryProposalId>:<exitProposalId>` accession |
| `insider-form4` | `sec_insider_transactions` aggregated per (cik, accession, insider), P/S codes only, CIK→ticker via `loadCikMap` | `storeDocument` | `insider-form4:<accession>:<cik>:<insider>` |

Explicitly out of scope (refresh on their own cadence; documented in the module header): 8-K
summaries, FMP transcripts (rights-gated), congress trades, fundamentals cards.

## Why / key decisions

- **Never bypasses vector-db primitives.** Every embed goes through `storeDocument` (or
  `storeContexts` for experience-memory, whose retrieval-critical metadata — return_pct,
  risk_exit, factor scores, proposal/run ids — has no home in `storeDocument`'s filing-shaped
  `ChunkInput`). Ledger receipts, `chunk_occurrences`, both daily budget fuses, and embed batch
  pacing all apply automatically.
- **Cross-space skip-if-exists is inherited, not reimplemented.** `storeDocument`'s commit id
  (`vcommit:v3:` hash, vector-db.ts:3298-3310) and every occurrence vector id incorporate the
  model-aware embedding-space revision (`embeddingSpaceRevisionForModel`, vector-db.ts:146-149 —
  bare `v1` for Voyage, `v1-baai-bge-m3` for bge). `committedVectorCommitDisposition`
  (vector-db.ts:3031-3110), checked at the top of the serialized commit block
  (vector-db.ts:3368-3399) BEFORE any provider call, returns an exact `reusedCommitted` receipt
  when the same content was already committed in the SAME space — so a rerun is free — and
  naturally misses when the space differs — so a model flip re-embeds. No new guard needed for the
  `storeDocument` paths.
- **The one guard that WAS needed:** `storeContexts` (experience-memory) has no model-aware
  commit id — its Pinecone id comes from `contextId` (source/symbol/accession/timestamp,
  vector-db.ts:1853-1860) and its `dedupKeyPrefix` content-hash dedup is model-agnostic. Fix:
  the re-embed uses a dedup prefix namespaced by the active embed revision
  (`experience-memory:reembed:v1-baai-bge-m3`), so same-space reruns dedup for free and a model
  flip re-embeds. Because the Pinecone id is stable across models, the re-embed OVERWRITES the
  old vector in place — no legacy residue, which is why `experience-memory` is excluded from the
  purge scan.
- **Watermarks** live in the internal settings table (`corpusReembed:progress`), advanced only
  after each item is processed and persisted per-item, so a crash/restart resumes precisely.
  Budget exhaustion (`budgetSkipped`/`writeUnitBudgetSkipped`/`unconfigured` from the store
  result) stops the WHOLE run (the fuses are shared across sources) without advancing past the
  deferred item. Dry runs persist NOTHING.
- **Lease serialization:** real runs go through a new `startDetachedOperationLease` primitive in
  `operation-lease.ts` (fire-and-forget acquisition + heartbeat + owner-token release; the
  existing `runWithOperationLease` can't return before its callback finishes). Same
  `RAG_REINDEX` group as `refreshFilingBodies`/`reconcileManagedVectorRecords`, so a re-embed
  can never race scheduled SEC ingest, and a second POST while running gets HTTP-busy.
- **Legacy purge is separate, explicit, and double-gated:** requires
  `{action:'purge-legacy', confirm:'purge-voyage-vectors'}`, refuses while Voyage is still the
  active model, and refuses unless the progress state shows `completed` under the CURRENT embed
  revision (with zero failures) for every covered docType. Deletion uses the new
  `purgeManagedVectorsByIds` primitive in vector-db.ts (exact-id `deleteMany` batches, same
  pattern as account erasure's `purgeExactIds`; never a metadata-filter delete), targeting only
  vector ids proven by local receipts (`vector_ingest_commits.embed_revision != current`).
- **Admin route posture:** `requireAdmin(request, { requireTokenInProd: true })` — same as
  `/api/admin/reindex-10k`, because a real run spends provider budget.

## Files

- `src/lib/rag/corpus-reembed.ts` — NEW: module described above.
- `app/api/admin/reembed/route.ts` — NEW: GET progress / POST run / POST purge-legacy.
- `src/lib/operation-lease.ts` — added `startDetachedOperationLease` (+ `OperationLeaseStartResult`).
- `src/lib/vector-db.ts` — added `purgeManagedVectorsByIds` (additive; placed next to the
  account-erasure purge machinery it generalizes).
- `src/lib/experience-memory.ts` — added `listClosedLotExperienceDocumentsForAccount`
  (additive; the live `recordClosedLotExperience` write-hook is untouched).
- `src/lib/earningscalls-transcripts.ts` — exported previously-private `accessionFor`.
- `test/corpus-reembed.test.ts` — NEW: 7 tests (temp SQLite DB + mocked Pinecone/Voyage per the
  `vector-db-document-receipts.test.ts` pattern; bge-m3 activated by storing a per-user
  `openrouter` API key, since `activeEmbeddingModel` keys off `resolveApiKey`).
- `docs/rollouts/2026-07-18-corpus-reembed.md` — this note.

## Verification

Commands actually run (Node 24 via `/opt/homebrew/opt/node@24/bin` — the Mac node26 ABI trap):

```bash
npx vitest run test/corpus-reembed.test.ts                       # 7/7 passed
npx vitest run test/vector-db.test.ts test/embedding-space-isolation.test.ts \
  test/operation-lease.test.ts test/experience-memory.test.ts \
  test/earningscalls-transcripts.test.ts test/vector-db-document-receipts.test.ts
npx tsc --noEmit
npx eslint src/lib/rag/corpus-reembed.ts app/api/admin/reembed/route.ts \
  src/lib/operation-lease.ts src/lib/vector-db.ts src/lib/experience-memory.ts \
  src/lib/earningscalls-transcripts.ts test/corpus-reembed.test.ts
```

(Full `npm test`/`npm run build` deferred to the `verify` CI gate on the PR, per task scope.)

Test scenarios covered: FTS-sourced filing text lands in the bge-m3 space with correct
`embed_model`/`embed_revision` stamps; full-rescan rerun reuses committed receipts with zero
provider calls (idempotency); budget exhaustion mid-run stops cleanly with a resumable watermark
and the deferred item embeds on resume; dry run returns counts with zero embeds/upserts and zero
persisted state; dry run classifies already-committed current-space content as reused; purge
refuses on incomplete coverage, on a wrong confirm token, and while Voyage is still active.

## Follow-ups / risks

- **Insider Form-4 `filedAt` approximation:** `sec_insider_transactions` has no accepted-at
  column, so re-embedded insider docs use `MAX(period_of_report)` as the filed/point-in-time
  stamp. Slightly earlier than the true EDGAR acceptance time → conservatively PIT-safe for
  as-of retrieval (never claims later availability than reality), but the text differs in that
  one field from live-path documents.
- **`symbols` filter scope:** applies to sec-filings / earningscalls / insider-form4 only;
  experience-memory always runs account-granular (documented in-module).
- **Experience-memory dry-run counts** report "would embed" without a per-doc reuse estimate
  (the `storeContexts` dedup check is per-batch); counts for that docType are an upper bound.
- **Ops metric to watch during the prod run:** `GET /api/admin/reembed` per-docType `failed`
  counts, plus the standard usage-limit alerts (the run deliberately trips them if it hits a
  fuse). Sentry breadcrumbs come free via the existing store pipeline.
- The bare FTS join means any historical FTS rows whose accession is missing from `sec_filings`
  still re-embed (form defaults to 10-K, dates fall back) — acceptable; the text + accession are
  what retrieval needs.
