# 2026-07-12 — Add clearCache support to admin reindex endpoint (Antigravity)

## Summary
Added support for a `clearCache: true` option in the `POST /api/admin/reindex-10k` request body. When set, this option deletes all records in the local SQLite `ingested_accessions` and `document_chunks` cache tables. This allows a clean backfill run into a fresh Pinecone database without the local cache incorrectly skipping filings.

## Why
The new `socratic-trade` Pinecone database was empty of filings, but the local SQLite database had grandfathered `112` document chunks recorded from previous test runs. Because of content-hash and accession-level de-duplication, the backfill was falsely skipping these records. Clearing the cache aligns the database metadata with the empty state of the new Pinecone index.

## Files
- `app/api/admin/reindex-10k/route.ts` [MODIFY]
- `docs/rollouts/2026-07-12-admin-reindex-clearcache.md` [NEW]

## Verification
- Ran `npx tsc --noEmit` and verified TypeScript compilation is clean.
- Verified that the `clearCache` flag properly executes SQL delete statements inside the admin lease guard.
