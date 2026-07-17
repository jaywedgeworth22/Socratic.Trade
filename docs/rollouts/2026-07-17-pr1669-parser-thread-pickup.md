# 2026-07-17 — PR #1669 parser-thread pickup (cap-reset, CLAUDE-sub)

## Summary

Owner-directed pickup of the stalled Antigravity lane (`agent/ag-rag-backfill-p3`,
PR #1669 — SEC/RAG Backfill Phase 3: HTML Cheerio parser + section-aware chunker).
The lane was ~2.5h stale with 6 unresolved Codex review threads. All 6 are now
addressed:

1. **Preserve form-specific Item 1 titles** (threads `PRRT_kwDOS7mOVM6RVirl` +
   design-question twin `PRRT_kwDOS7mOVM6RlMdo`; also duplicated later as
   `PRRT_kwDOS7mOVM6Ro-Ah`). Implemented the coordinating session's decision
   (option 3 of the design question): `parseFilingHtml` now takes
   `options?: { formType?: string }`, and `standardizeTitle` applies the 10-K
   Item-code → canonical-title map ONLY when the caller passes a form type
   matching `/^10-K/i`. All other forms (10-Q, unknown) keep the raw title parsed
   from the filing text — so a 10-Q's `Item 1. Financial Statements` is no longer
   rewritten to "Business". Both production callers now pass the form type:
   `ingestFiling` (`filingRef.docType`) in `src/lib/web-sources/sec-filings.ts`
   and the `validated` checkpoint in `src/lib/rag/sec-ingest-worker.ts`
   (`task.payload.docType`).
2. **Version the accession skip with the parser revision** (threads
   `PRRT_kwDOS7mOVM6RVir4` + twin `PRRT_kwDOS7mOVM6RlMlm`). Implemented decision
   option 3: previously-ingested filings deliberately stay on v1 chunks; only
   filings not yet in the `ingested_accessions` ledger get the v2 (Cheerio,
   section-aware) treatment. No migration, no ledger clears. This is now
   documented in an explicit code comment at the `hasIngestedAccession` preflight
   in `ingestFiling`, including the sanctioned escape hatch (a one-time explicit
   invalidation of ledger rows) should a corpus-wide re-parse ever be wanted.
3. **Recognize standalone SEC section headings** (`PRRT_kwDOS7mOVM6RmSzN`).
   Added a bounded `STANDALONE_SECTION_HEADINGS` set — Risk Factors,
   Management's Discussion (and Analysis...), (Unaudited/Condensed/Consolidated)
   Financial Statements (and Supplementary Data), Legal Proceedings,
   Quantitative and Qualitative Disclosures About Market Risk, Controls and
   Procedures. Patterns are anchored to the FULL trimmed block text (a prose
   cross-reference like "see Risk Factors above" can never match) and run under
   the same structural guards as Item/Part headings (heading tag, leaf block, or
   EDGAR heading wrapper) — mirroring the anchoring discipline pinned by the
   earlier resolved threads. Codes are form-agnostic slugs (`RISK-FACTORS`,
   `MDA`, `FINANCIAL-STATEMENTS`, ...) rather than numeric Item codes, because
   the same title maps to different Item numbers on 10-K vs 10-Q.
4. **Emit valid Markdown for td-only tables** (`PRRT_kwDOS7mOVM6RmSzP`).
   `splitTableRows` with no real header row now synthesizes a neutral
   empty-cell header row of the right width above the delimiter in EVERY split
   block, so chunks are valid GFM tables instead of starting with a bare
   `| --- |` line. The first data row is NOT promoted to a repeated header
   (that approach was explicitly rejected in an earlier resolved thread); every
   data row appears exactly once across splits.

## Why

Auto-merge (squash) is armed on PR #1669 and branch protection requires all
review threads resolved + green `verify`. These 6 threads were the stale
remainder of the Codex review of the parser work; decisions for the two
design-question threads were made by the coordinating CLAUDE session (option 3
in both cases) and are implemented here exactly.

## Files

- `src/lib/web-sources/sec-parser.ts` — form-aware `standardizeTitle` /
  `normalizeItemCode` / `collectBlocks` / `parseFilingHtml(options.formType)`;
  `STANDALONE_SECTION_HEADINGS` + `matchStandaloneHeading`; td-only branch of
  `splitTableRows` synthesizes an empty header row.
- `src/lib/web-sources/sec-filings.ts` — decision comment at the
  `hasIngestedAccession` preflight; `parseFilingHtml` call passes
  `{ formType: filingRef.docType }`.
- `src/lib/rag/sec-ingest-worker.ts` — `parseFilingHtml` call passes
  `task.payload.docType` as `formType`.
- `test/sec-parser.test.ts` — existing Item-normalization test now passes
  `{ formType: "10-K" }`; 3 new regression tests (form-specific Item 1 titles,
  standalone headings incl. anchored-match negative case, valid td-only GFM
  tables with no promoted/duplicated rows).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

Run from the pickup worktree (node_modules symlinked to the main checkout's
install; `cheerio@1.2.0` had to be added there via `npm install --no-save
cheerio@1.2.0` because the shared install predated this branch's new
dependency — package.json/package-lock untouched by --no-save):

- `npx tsc --noEmit` — clean (0 errors).
- `npm test -- test/sec-parser.test.ts` — 9/9 green.
- `npm test` — 407 files / 4,679 tests, all green.
- `npm run lint` — 0 errors (548 pre-existing grandfathered warnings).
- `npm run build` — production Next.js build succeeded.

## Follow-ups / risks

- **PR #1669 is still NOT mergeable after this pickup.** Codex re-reviewed the
  lane's later pushes and posted ~20 additional unresolved threads between
  2026-07-17 00:24 and 03:16 UTC — outside this pickup's scope. They include
  two P1s on the OpenRouter/SiliconFlow embedding-provider work
  (`vector-db.ts`: alternative-provider branch unreachable when a real Voyage
  client exists; BGE vectors mixed into the Voyage Pinecone corpus without
  namespace/revision isolation) plus P2s across `sec-ingest-worker.ts`,
  `sec-facts.ts`, `search-fusion.ts`, `db-learning.ts`, and the eval harness.
  Auto-merge stays blocked until those are addressed or the owner rules
  otherwise.
- The effort-log row marking PR #1669 "COMPLETED 2026-07-16" was corrected in
  place (PR not merged); see `docs/EFFORT-LOG.md`.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board) is not
  reachable from this cloud environment — the repo mirror `docs/EFFORT-LOG.md`
  was updated; the next Mac-side session should sync the live board.
