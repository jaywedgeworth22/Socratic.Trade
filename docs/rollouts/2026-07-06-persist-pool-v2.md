# 2026-07-06 - persist-pool-v2

## Summary

- Persist the PRE-`rankPool` candidate pool (`matches` in `retrieveContextDetailed`,
  `src/lib/vector-db.ts`) together with a per-candidate DISPOSITION naming the exact stage that
  dropped it (or `used`/`kept_not_used` for survivors), so "why did we drop this candidate" is
  finally analyzable — not just "did the final top-N cut lose an otherwise-qualified survivor"
  (the honest, narrower scope of #979/v1, `RAG_PERSIST_CANDIDATE_POOL`).
- `rankPool` (`vector-db.ts`) gained an OPTIONAL 5th-shape param on `RankPoolOptions`:
  `onDispositions?: (dispositions: Map<string, CandidateDisposition>) => void`. When supplied,
  `rankPool` tracks every input candidate through each stage as it filters
  (minScore → asOf → rerank-truncate → post-rerank relevance floor → dedupe) and invokes the hook
  exactly once with the full map before returning. Every EXISTING call site (production and every
  test in `test/rag-retrieval-regression.test.ts`) passes no hook, so `rankPool` remains a byte-
  identical pure function for them: no `Map` allocation, no key computation, no extra pass over the
  pool, same return value as before this change.
- `retrieveContextDetailed` wires a NEW, INDEPENDENT flag — `RAG_PERSIST_CANDIDATE_POOL_FULL`
  (envFlagOn-parsed, **default OFF**) — distinct from v1's `RAG_PERSIST_CANDIDATE_POOL` so the two
  toggle separately. The flag is checked BEFORE `rankPool` even runs (`wantFullPool`), mirroring
  v1's "no-op, not a suppressed write" posture: off means no hook is even constructed, so `rankPool`
  runs its exact pre-v2 path.
- New `recordCandidatePoolFull(record, userId)` in `src/lib/rag/candidate-pool.ts` persists via the
  existing `audit()` primitive under a NEW, distinct event kind `"rag_candidate_pool_full"` (v1's
  kind, `"rag_candidate_pool"`, is untouched) — no new table. Each candidate entry carries only
  `id`/`score`/`relevanceScore`/`docType`/`asOf`/`disposition` — never raw chunk text, same posture
  as v1/`hashQuery`.
- Dispositions (`CandidateDisposition` union): `dropped_minscore`, `dropped_asof`,
  `dropped_rerank_truncate` (Voyage's own `topK` cut, BEFORE the relevance floor runs),
  `dropped_rerank_floor`, `dropped_dedupe`, `kept_not_used` (survived rankPool, cut only by the
  caller's final top-`limit` slice), `used` (in the final slice).

## Why

- #979/v1 was built and merged with an explicit, honest limitation documented in its own rollout
  note: it captures `rankPool`'s OUTPUT (`ordered`), which is already POST minScore/asOf/hybrid/
  rerank/dedupe. Anything dropped by those stages never enters `ordered` and so was invisible to
  v1 — worse, in the FLAGSHIP production caller (`strategy.ts`'s filings pass: `dedupeSimilarity`
  = 0.6 non-null, `limit` = 3), both `dedupeSimilar` and `rerankMatches` already hard-cap their own
  output at `limit`, so `ordered.length <= limit` always holds there and essentially every
  persisted v1 row is `used:true` — near-zero `used:false` rows in exactly the path the feature was
  meant to illuminate, and ZERO visibility into the actually-interesting minScore/asOf/dedupe/
  rerank drops. v2 closes that gap by capturing the raw PRE-rankPool pool instead, with a drop
  reason attached to every candidate that didn't survive.
- The #822 multi-query/HyDE fan-out (`RetrieveOptions.queries`) fuses every query variant's matches
  into ONE pool (`matches` -> `rankPool` -> `ordered`) BEFORE `rankPool` runs, so capturing at the
  `matches` stage (same as v1's capture point relative to `ordered`) automatically covers the fused
  pool with no special-casing — exactly one record per `retrieveContextDetailed` call, matching v1's
  contract.

## Files

- `src/lib/rag/candidate-pool.ts` — added (below the existing v1 code, which is untouched):
  `candidatePoolFullPersistEnabled()`, `CandidateDisposition` (exported union type),
  `CandidatePoolEntryV2`/`CandidatePoolRecordV2` types, `recordCandidatePoolFull()`.
- `src/lib/vector-db.ts` — two distinct touched regions (see "Coordination" below for why this
  matters to the merge-forward):
  1. **`rankPool` region** (`RankPoolOptions` interface + the `rankPool` function body, roughly
     lines 2091-2320 pre-edit numbering): added the `onDispositions` option and threaded disposition
     tracking through the existing minScore filter, the existing as-of filter (WRAPS the existing
     `isWithinAsOf` call — does not replace or re-derive its logic), a new rerank-truncate detection
     (comparing `fusedPool` against `ordered` by a stable key, since `rerankMatches` returns new
     spread objects), the existing relevance-floor filter, and the existing dedupe call. All
     tracking is gated behind `typeof options.onDispositions === "function"` so it costs nothing
     when absent.
  2. **`retrieveContextDetailed` capture region** (immediately AFTER v1's existing capture block,
     before `const finalChunks = ...`): the `wantFullPool`/`capturedDispositions` wiring around the
     `rankPool(...)` call, and the new `recordCandidatePoolFull(...)` call block. Does not touch the
     query-filter-building code earlier in the function (imports, `buildExtraFilters`, the
     multi-query fan-out block) at all.
- `test/persist-candidate-pool-v2.test.ts` (new) — 9 tests: flag-off no-op (default unset + explicit
  `off`), flag-on capture with correct dispositions across a mixed pool (minScore/asOf/final-slice/
  used, dedupe off to isolate it), a dedicated dedupe-drop test, a rerank-truncate test, a combined
  rerank-truncate + relevance-floor test, the #822 multi-query fused-pool case, both-flags-on
  independence (v1 and v2 persist separately with different payloads), and queryHash stability.
- `test/rag-retrieval-regression.test.ts` — extended (v1's own suite, untouched otherwise) with a
  new `persist-pool-v2 — rankPool's optional onDispositions hook` describe block (7 tests): every-
  candidate-gets-one-disposition, dedupe-drop, rerank-truncate (distinct from the relevance floor),
  combined truncate+floor, id-less-candidate distinct-key hardening, and a pure-function-regression
  test proving `rankPool`'s return value is unaffected by whether a hook is passed.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/persist-candidate-pool.test.ts test/persist-candidate-pool-v2.test.ts
  test/rag-retrieval-regression.test.ts` — 43/43 passed (8 v1 + 9 v2 wiring + 26 regression-net,
  confirming v1 is unaffected and `rankPool`'s as-of/rerank/hybrid fail-safes still hold).
- Spot-checked beyond the task's required set (still scoped, not full `npm test`):
  `test/rag-retrieval-eval.test.ts`, `test/rag-retrieval-status.test.ts`,
  `test/vector-db-rerank-floor.test.ts`, `test/vector-db-rerank-overfetch.test.ts`,
  `test/vector-db-hybrid.test.ts`, `test/vector-db-asof-strict.test.ts`,
  `test/rag-multi-query-retrieval.test.ts`, `test/rag-multi-query.test.ts`,
  `test/rag-dedupe-similar.test.ts`, `test/vector-db.test.ts`, `test/vector-db-retrieval.test.ts`,
  `test/vector-db-provenance.test.ts` — 138/138 additional tests green, no regressions.
- Full `npm test` / `npm run build` intentionally NOT run in this worktree per task scope — a
  central operator/`scripts/land.sh` runs the full gate at landing time.

## Coordination (for the merge-forward)

Sibling lane `claude/server-asof-filter` also edits `src/lib/vector-db.ts` + `rankPool`'s as-of
stage (adds a Pinecone server-side as-of filter, so fewer future chunks reach `matches`, and may
adjust the `isWithinAsOf`/asOf-drop logic) and lands BEFORE this one. This lane:
- Keeps disposition tracking WRAPPED around whatever as-of logic exists at merge time — the
  `dropped_asof` disposition is assigned from the SAME `kept`/`isWithinAsOf(...)` boolean the
  filter already computes, not a re-derived check. If the sibling lane changes what counts as
  "kept" under as-of, `dropped_asof` inherits that change for free.
- Keeps the `retrieveContextDetailed` capture edits in their own region, distinct from wherever the
  sibling lane's query-filter-building changes land (that lane's likely region is earlier in the
  function, around `buildExtraFilters`/the Pinecone `index.query(...)` filter objects — not touched
  by this lane at all).
- Net effect: the merge-forward should be a clean 3-way merge (sibling's as-of-stage edit ABOVE
  this lane's disposition-tracking additions in the same filter block) rather than an overlapping
  edit to the same lines, but re-run `test/rag-retrieval-regression.test.ts` and
  `test/persist-candidate-pool-v2.test.ts` after merging forward to confirm.

## Follow-ups

- No new table was added (`audit_events` via `audit("rag_candidate_pool_full", ...)`), matching v1's
  precedent. A dedicated indexed table would be a future migration in `db.ts` + a new `db-*` module
  if volume/query-pattern needs later warrant it.
- This is observability-only, same as v1: nothing here changes retrieval, ranking, or what gets
  injected into any prompt. Both flags default OFF and are independent; enabling v2 does not require
  or imply enabling v1.
- Not yet pushed or PR'd (per task scope) — committed locally on `claude/persist-pool-v2` in worktree
  `trading-wt-pool-v2`, off `origin/main` at `b76b11ae`.
