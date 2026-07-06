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
