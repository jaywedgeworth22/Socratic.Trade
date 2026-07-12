# 2026-07-12 — Add clearCache support to admin reindex endpoint (Antigravity)

## Summary
Added support for a `clearCache: true` option in the `POST /api/admin/reindex-10k` request body. When set, this option deletes all records in the local SQLite `ingested_accessions` and `document_chunks` cache tables. This allows a clean backfill run into a fresh Pinecone database without the local cache incorrectly skipping filings.

## Why
The new `socratic-trade` Pinecone database was empty of filings, but the local SQLite database had grandfathered `112` document chunks recorded from previous test runs. Because of content-hash and accession-level de-duplication, the backfill was falsely skipping these records. Clearing the cache aligns the database metadata with the empty state of the new Pinecone index.

## Files
- `app/api/admin/reindex-10k/route.ts` [MODIFY]
- `docs/rollouts/2026-07-12-admin-reindex-clearcache.md` [NEW]

## Post-hoc fix (2026-07-12, codex-autofix PR #1493)

Codex review flagged two P2 issues:

1. **Unscoped DELETE**: The `clearCache: true` code was `DELETE FROM ingested_accessions` and `DELETE FROM document_chunks` (full table truncation), even when only a few symbols were requested. Scoped to `DELETE FROM ingested_accessions WHERE ticker IN (?)` and `DELETE FROM document_chunks WHERE symbol IN (?)` using the same placeholder list.

2. **Unnormalized symbols**: The raw request-body symbols were used directly. Since `refreshFilingBodiesUnlocked` silently skips tickers not in the CIK map (e.g. lowercase "aapl"), an invalid/typo ticker could clear unrelated cache entries without repopulating. Added `normalizeSymbol()` (`.trim().toUpperCase()`) and dedup (Set) when parsing the `symbols` array.

### Verification
- `npx tsc --noEmit`: clean
- `npm test`: 350 files, 3927 tests passed
- `npm run build`: clean
- Auto-merge enabled on PR #1493
- Both Codex threads resolved
