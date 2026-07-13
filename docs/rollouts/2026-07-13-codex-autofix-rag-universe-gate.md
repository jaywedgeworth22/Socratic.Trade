# Codex Autofix: RAG Universe Gate — PR #1543

## Summary
Addressed all 3 Codex review findings on PR #1543 (`codex/sec-rag-program`):
1. **P1 — Freeze expected task count** (`src/lib/db-rag-ingest.ts`): `sealSecIngestJobIntake` now refuses to overwrite a non-null `job.expected_tasks` with a mismatched caller-supplied count, preventing a partial corpus from being sealed under a different contract.
2. **P2 — Reject impossible receipt dates** (`src/lib/rag/universe-manifest.ts`): `validDate()` now round-trips parsed calendar components to reject impossible dates (e.g. Feb 31) that `Date.parse` silently normalizes.
3. **P2 — Validate quarantined issuer entries** (`src/lib/rag/universe-manifest.ts`): `validateSecUniverseManifest` now shape-checks each quarantined entry (reason required non-empty, ticker/cik are non-empty when present).

## Files touched
- `src/lib/db-rag-ingest.ts` — added guard against mismatched expected_tasks when job.expected_tasks is non-null
- `src/lib/rag/universe-manifest.ts` — hardened `validDate()` with ISO round-trip check; added quarantined entry validation
- `test/rag-ingest-worker.test.ts` — proves a smaller observed count cannot rewrite/seal a predeclared contract
- `test/rag-universe-manifest.test.ts` — covers impossible calendar dates and malformed quarantine rows

## Verification
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint`: 0 errors / 448 inherited warnings
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`: clean
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`: 352 files / 3,953 tests passed
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build`: clean; known non-fatal Tailwind prose-scan warning recorded separately
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/rag-ingest-worker.test.ts test/rag-universe-manifest.test.ts`: 2 files / 19 tests passed after the regression additions
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint test/rag-ingest-worker.test.ts test/rag-universe-manifest.test.ts`: 0 errors
- `git diff --check`: clean

## Follow-ups
- All 3 Codex findings are addressed and regression-covered. Auto-merge remains enabled; refreshed hosted checks and merge/deploy verification remain.
