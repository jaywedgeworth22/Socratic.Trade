# 2026-07-13 — Codex autofix: 3 residual PR 1543 RAG review items

## Summary
Addressed 3 unresolved P2 codex-connector review threads remaining on merged PR #1543. All three were correctness-hardening guards inside `src/lib/db-rag-ingest.ts`.

## Why
The Codex review on PR #1543 left 3 unresolved threads. Since the PR had already been merged, the fixes were committed to a follow-up branch.

## Files touched
- `src/lib/db-rag-ingest.ts` (+11, -3)
  - `failSecIngestTask`: validate `errorType`/`error` are non-blank
  - `advanceSecIngestTask`: `CASE` instead of `COALESCE` for checksum columns
  - `boundedLeaseMs`: guard against `NaN`/`Infinity` before floor/clamp

## Decisions
1. **Nonblank errors**: Follows the same `requiredTerminalReason` pattern already used by `terminalizeSecIngestTask` — throws on empty/whitespace rather than silently persisting.
2. **Checksum preservation**: Using `CASE WHEN col IS NOT NULL THEN col ELSE ? END` rather than rejecting mismatches, since a later checkpoint with a matching hash is harmless and rejecting would break idempotent replays.
3. **Lease NaN guard**: Fall back to the default 5-minute lease when `value` is non-finite, rather than throwing — matches the "fall back to default" semantics of the `value ?? 5 * 60_000` line already present.

## Verification
```
npm run lint       # 0 errors, 452 inherited warnings
npx tsc --noEmit   # restored next-env.d.ts/tsconfig.json from origin/main
npm test           # 352 files / 3,960 tests passed
npm run build      # production build succeeded
```

## Resolved threads
- `PRRT_kwDOS7mOVM6QfUfV` — Require nonblank failure reasons
- `PRRT_kwDOS7mOVM6QfUfb` — Preserve existing artifact checksums  
- `PRRT_kwDOS7mOVM6QfUff` — Sanitize lease duration before computing expiry

## Follow-ups
- Branch `codex/autofix-1543-residual` pushed to origin. Needs a PR -> `main` created manually (GitHub Actions runner lacks `createPullRequest` permission).
