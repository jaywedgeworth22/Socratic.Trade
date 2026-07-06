# 2026-07-06 - corpus-coverage-receipt

## Summary

- Added a per-run, advisory-only receipt for the strategy.ts filings-RAG pass: when a requested
  doc type (`10-k`/`10-q`/`8-k`/`earnings-transcript`) produces **zero retrieved chunks this run**
  AND the corpus has **zero ever-ingested rows** of that type (all tickers, all time), emit ONE
  `audit('rag_doc_type_coverage_empty', { runId, symbols, emptyDocTypes, requestedDocTypes })` +
  ONE kind-`safety` `SocraticEvidenceItem` ("Requested filings doc type never ingested") attached
  to the run's decision case(s).
- A doc type that simply didn't rank this run's query but DOES have ingested rows is normal
  (happens daily) and deliberately does **not** fire — only "this evidence structurally cannot
  exist yet" is worth a receipt.
- Purely advisory: never touches `ragContext`, sizing, or policy. Modeled directly on the existing
  `evidence_age_anomaly` receipt block (same `promptSafetyEvidence` array, same `audit()` call
  shape, same unconditional wiring — no flag, matching that precedent).

## Why

- Ground truth (triage-verified before implementation): `src/lib/strategy.ts`'s filings-RAG pass
  (`retrieveContextDetailed(..., { docType: ["10-k","10-q","8-k","earnings-transcript"] })`) is the
  only doc-type-requesting call site in the app, and `contexts.flatMap(chunks)` silently drops a
  zero-producer doc type with no receipt today. `earnings-transcript` is a genuine zero-producer
  right now (no ingestion writer exists anywhere in the repo for it) — this receipt makes that
  visible per-run instead of silently invisible.
- The both-conditions gate (not-retrieved-this-run AND zero-ever-ingested) is the load-bearing
  design choice: a naive "requested but empty this run" check would false-positive constantly on
  ordinary low-relevance misses for 10-K/10-Q/8-K, which DO have ingested rows most of the time.
- Discovered mid-implementation: `ingested_accessions.doc_type` is not uniformly named across
  writers. `src/lib/web-sources/sec-filings.ts` stores the raw SEC form letter (`"10-K"`/`"10-Q"`)
  matching the requested type case-insensitively, but `src/lib/web-sources/sec8k.ts` stores the
  sentinel `"8-K-body"` — never the plain `"8-K"`. A naive `LOWER(doc_type) === requested` lookup
  would therefore report **zero** ingested 8-K rows forever, even after real 8-K ingestion ran,
  which would make the new receipt false-positive on 8-K every single day. Fixed by having the
  count lookup treat any stored type whose lowercased form **starts with** the requested
  (lowercased) type as a match for that type — `"8-k-body"` counts toward `"8-k"`; `"10-k"` counts
  toward `"10-k"` exactly (no other stored type shares that prefix, so this is safe).

## Files

- `src/lib/db-learning.ts` — new `ingestedAccessionCountsByDocType()` (one `GROUP BY
  LOWER(doc_type)` query, no new table/migration) and `ingestedAccessionCountForDocType(type)`
  (prefix-tolerant lookup on top of it, documented naming-split rationale inline). Both
  re-exported via the `db.ts` barrel (`export * from "./db-learning"` already existed).
- `src/lib/prompt-safety.ts` — new pure `computeEmptyDocTypes(requestedDocTypes,
  retrievedDocTypes, ingestedCountByRequestedType)` alongside the existing
  `collectEvidenceAgeAnomalies`; module header comment updated to describe the third scanner.
- `src/lib/strategy.ts` — hoisted the filings-pass doc-type request list to
  `requestedFilingsDocTypes` (used by the existing `retrieveContextDetailed` call, unchanged
  behavior); added `retrievedFilingsDocTypes` (populated alongside the existing
  `evidenceAgeInputs` loop over `contexts`/chunks); added the new receipt block immediately after
  the `evidence_age_anomaly` block, following the same `audit()` + `promptSafetyEvidence.push()`
  shape. Added `ingestedAccessionCountForDocType` to the `./db` import block and
  `computeEmptyDocTypes` to the `./prompt-safety` import block.
- `test/rag-doc-type-coverage.test.ts` — new test file (10 tests, see Verification).
- `STATUS.md`, `docs/EFFORT-LOG.md` — pre-commit handoff updates for this lane.

## Verification

- `npx tsc --noEmit` — clean (no errors).
- `npx vitest run test/rag-doc-type-coverage.test.ts` — **10 passed / 10** (see breakdown below).
- Regression spot-checks on files/behavior this change is adjacent to — all green, no changes
  needed:
  - `npx vitest run test/prompt-safety.test.ts test/strategy-prompt-safety.test.ts
    test/strategy-rag-quickwins-wiring.test.ts test/rag-multi-query-retrieval.test.ts` — **42
    passed / 42**.
  - `npx vitest run test/sec8k-full-body.test.ts test/sec-filings.test.ts` — **31 passed / 31**
    (confirms the `insertIngestedAccession` naming-split assumption documented above against the
    real writers' own test suites).
- Did NOT run the full `npm test` / `npm run build` suite per this lane's task scope (focused
  verification only; a central operator runs full CI via `scripts/land.sh`).

### `test/rag-doc-type-coverage.test.ts` breakdown

- `computeEmptyDocTypes` (pure, 5 tests): flags only the empty-and-never-ingested type out of 4
  requested; does not flag a type with ingested rows even if missing this run; flags nothing when
  everything retrieved; flags nothing when every missing type has ingested rows; case-insensitive
  on both `doc_type` and requested type.
- `ingestedAccessionCountForDocType` / `ingestedAccessionCountsByDocType` (DB helper, 2 tests):
  reports 0 for a never-ingested type; reports non-zero for both the `"10-K"` writer shape and the
  `"8-K-body"` sentinel shape, while `"earnings-transcript"` stays 0.
- Strategy-level integration via `runStrategyOnce` with `vector-db` mocked and the local test
  broker gateway (3 tests): (b) fires exactly one audit + one evidence item naming only
  `earnings-transcript` when 2 of 4 requested types retrieve nothing and `10-q` (the other missing
  type) has a seeded ingested row; (c) does NOT fire when the only missing-this-run type
  (`earnings-transcript`) also has a seeded ingested row; (d) advisory invariant — proposal count
  and `ragContext` (`retrievedFinancialContext` in the Bull user prompt) are unchanged by the
  receipt firing, and the receipt text never leaks into `ragContext`.

## Follow-ups

- No new `earnings-transcript` ingestion writer was added — out of scope for this lane (the ground
  truth explicitly notes it's a genuine zero-producer today; this receipt only makes that visible,
  per the owner's advisory-only philosophy).
- If a future writer starts inserting `ingested_accessions` rows under yet another non-uniform
  `doc_type` naming convention (beyond the two documented here), extend the prefix-matching
  rationale comment on `ingestedAccessionCountForDocType` rather than special-casing silently.

## Correction (same day, 2026-07-06) — the `ingested_accessions`-based producer check was itself a daily false positive

A post-merge review caught that this rollout's own "Why" section above contained a load-bearing
**false claim**: it asserted 10-K/10-Q/8-K "DO have ingested rows most of the time," which is true
for 10-K/10-Q but **not** for 8-K in the default configuration. This section documents the actual
bug, why the original design was wrong, and the corrected approach. The `## Files`/`## Verification`
sections above are LEFT AS-IS (historical record of the original PR) — this section is the
authoritative account of what shipped after the fix.

### The bug

`src/lib/web-sources/sec8k.ts` has **two** independent 8-K ingestion writers, gated by different
flags:

- **8-K SUMMARY** (`refreshEightK`'s `storeContexts` call, ~line 318 and ~397 for the two call
  sites — initial dataset store + refresh-cycle store): `WEB_SOURCE_SEC8K`, **default ON**. Writes
  retrievable `doc_type: "8-k"` chunks straight to the vector corpus via `storeContexts`. **Never
  calls `insertIngestedAccession`** — it has no accession-tracking call at all, because
  `storeContexts`'s own content-hash dedup (`document_chunks`, gated on
  `VECTOR_STORECONTEXTS_DEDUP`, default ON) is what prevents re-embedding, and that table is keyed
  on content_hash/symbol/source/chunk_id — it has **no `doc_type` column**.
- **8-K FULL-BODY** (`ingestEightKBody`, ~line 489): `WEB_SOURCE_SEC8K_FULL_BODY`, **default OFF**.
  Writes via `storeDocument`, and DOES call `insertIngestedAccession(accession, "8-K-body", ...)`.

Because the summary path is the one that's actually on by default, and it never touches
`ingested_accessions`, the original receipt's "has this doc type ever been produced" check
(`ingestedAccessionCountForDocType("8-k")`) returned **0 in the default config even when the corpus
had real, retrievable 8-K chunks**. That made the receipt fire "8-k" as a false-positive coverage
gap on any day an 8-K chunk simply didn't rank in the top-3 retrieved chunks — i.e. routinely, not
rarely. This is the exact daily-false-positive failure mode the receipt exists to prevent, just
aimed at the wrong doc type via the wrong signal.

### Why `document_chunks` (the reviewer's suggested fix) doesn't work either

The reviewer's suggested primary fix was to replace the `ingested_accessions` producer-existence
check with a count over `document_chunks` (the actual local chunk-write ledger), on the theory that
ALL doc_type writers populate it. Investigated and confirmed **not viable without a schema
change**:

- `document_chunks`'s schema (`src/lib/db.ts`) is `(content_hash, symbol, source, chunk_id,
  created_at)` — **no `doc_type` column exists**, so no `GROUP BY doc_type` is possible today.
- It is also not populated unconditionally: `storeContexts` (`src/lib/vector-db.ts`) only calls
  `insertDocumentChunks` when a `dedupKeyPrefix` option is passed (true by default for the 8-K
  summary and disclosure-RAG paths via `VECTOR_STORECONTEXTS_DEDUP`, but caller-dependent, not a
  structural guarantee) — `storeDocument` (used by 10-K/10-Q and 8-K full-body) does always record
  it, so behavior differs by call site.
- Even if a `doc_type` column were added, `source`/`dedupKeyPrefix` values are not a reliable
  doc_type proxy either: `disclosure-rag.ts` uses the single prefix `"disclosure"` for BOTH
  `doc_type: "congress-trade"` and `doc_type: "insider-filing"` — ambiguous without a real column.

Adding a `doc_type` column to `document_chunks` and backfilling every writer to populate it
correctly is a real schema migration touching five+ call sites (`sec-filings.ts`, `sec8k.ts`
summary + full-body, `disclosure-rag.ts`, `experience-memory.ts`, `socratic-memory.ts`,
`vector-db.ts`'s own direct-context path) — out of scope for this fix (no scope creep) and its own
source of regression risk.

### The corrected fix

Per the task's own documented fallback for exactly this situation: **dropped the
runtime-producer-count check entirely** and replaced it with a static, hand-verified allowlist,
`COVERAGE_CHECKED_DOC_TYPES = ["10-k", "10-q", "8-k"]` (`src/lib/strategy.ts`, near the top-level
constants) — doc types confirmed by reading the writers to have an actual producer in code today
(`10-k`/`10-q` via `sec-filings.ts`'s always-on `ingestFiling`; `8-k` via `sec8k.ts`'s both writers).
`computeEmptyDocTypes` (`src/lib/prompt-safety.ts`) dropped its third parameter
(`ingestedCountByRequestedType`) and now takes only `(coverageCheckedDocTypes, retrievedDocTypes)`
— a type is "empty" simply when it wasn't retrieved this run, with no ingested-rows condition at
all. This is intentionally a coarser check than the original design (it can't distinguish "this
type has literally never once produced a chunk" from "didn't rank today" for a type that IS in the
allowlist) — but it can no longer false-positive on a producer whose write path just doesn't touch
`ingested_accessions`, which is the actual bug that mattered.

**`earnings-transcript` exclusion (Finding 2 — noise):** it remains in
`requestedFilingsDocTypes` (the literal passed to `retrieveContextDetailed`'s `docType` filter —
harmless, unrelated to the receipt) but is now deliberately **excluded** from
`COVERAGE_CHECKED_DOC_TYPES`. It has no ingestion writer anywhere in the repo, so including it in
the coverage check would fire a receipt on literally every run forever — a permanent true-but-
useless signal that trains the operator to ignore the whole receipt, masking the genuinely useful
10-k/10-q/8-k signal (e.g. a fresh account with no ingestion yet). Re-add it to
`COVERAGE_CHECKED_DOC_TYPES` the day a producer for it lands.

**Efficiency nit fixed too:** the original loop called a per-type DB helper once per requested
type (4 separate `GROUP BY` queries per run). Since the corrected design makes zero DB calls at all
(no runtime producer signal left to query), this is moot — `computeEmptyDocTypes` is now pure
in-memory set arithmetic, called once.

**Files touched by the correction:**

- `src/lib/prompt-safety.ts` — `computeEmptyDocTypes` signature narrowed to
  `(coverageCheckedDocTypes, retrievedDocTypes)`; doc comment rewritten to describe the corrected
  behavior and explain why the ingested-rows condition was removed; module header's scanner-3
  summary updated.
- `src/lib/strategy.ts` — added `COVERAGE_CHECKED_DOC_TYPES` constant (with the full rationale
  above inline); removed the now-unused `ingestedAccessionCountForDocType` import and its per-type
  loop; the coverage receipt block now calls `computeEmptyDocTypes(COVERAGE_CHECKED_DOC_TYPES,
  retrievedFilingsDocTypes)` directly; `requestedFilingsDocTypes`'s comment updated to clarify it
  is NOT the same list the coverage check uses.
- `src/lib/db-learning.ts` — `ingestedAccessionCountForDocType`'s doc comment corrected to spell out
  the caveat above (it undercounts "8-k" in the default config) and explicitly says it is no longer
  used by the coverage receipt. The function itself is UNCHANGED and kept as a general-purpose
  admin/diagnostic helper (still correct for what it actually measures: full-body accession
  counts) — not removed, since removing a still-correct, still-used-by-tests helper was unnecessary
  scope beyond the fix.
- `test/rag-doc-type-coverage.test.ts` — rewritten: `computeEmptyDocTypes` pure tests updated to the
  new 2-arg signature; added the required regression test ("(c) REGRESSION (BLOCKER fix)") that
  stores an 8-K SUMMARY chunk via the mocked retrieval path with **no** `insertIngestedAccession`
  call anywhere in the test, and asserts the receipt does NOT fire for `"8-k"` — proving the fix;
  kept a light "(d)" test asserting `earnings-transcript` never produces a receipt even though it
  always retrieves nothing; kept the DB-helper tests for
  `ingestedAccessionCountForDocType`/`ingestedAccessionCountsByDocType` (now framed as generic
  diagnostic-helper coverage, not the receipt's signal).

### Verification (correction)

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/rag-doc-type-coverage.test.ts` — **11 passed / 11** (was 10; added the
  BLOCKER regression test).
- Regression spot-checks (unchanged from the original run, all still green):
  - `npx vitest run test/prompt-safety.test.ts test/strategy-prompt-safety.test.ts
    test/strategy-rag-quickwins-wiring.test.ts test/rag-multi-query-retrieval.test.ts` — **42
    passed / 42**.
  - `npx vitest run test/sec8k-full-body.test.ts test/sec-filings.test.ts` — **31 passed / 31**.
- `npx eslint src/lib/strategy.ts src/lib/prompt-safety.ts src/lib/db-learning.ts
  test/rag-doc-type-coverage.test.ts` — 0 errors, 4 pre-existing warnings in `strategy.ts`
  unrelated to this change (`isMarketOpen`/`e`/`currentPrices` unused-var grandfathered warnings).
- Did not run the full `npm test`/`npm run build` suite for this focused fix — same scope
  boundary as the original rollout; a central operator runs full CI via `scripts/land.sh`.
