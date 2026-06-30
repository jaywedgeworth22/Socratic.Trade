# 2026-06-30 - Policy Route Export Fix

## Summary

Fixed a production build failure introduced in the merged production sweep by
moving `stripNullsDeep` out of the app route module.

## Why

Next 16 validates app route module exports during `npm run build`. The merged
`app/api/policy/route.ts` exported `stripNullsDeep` for a unit test, which made
the route invalid even though the runtime policy logic was otherwise correct.

Antigravity strategy-review/test-quote fallback work is being handled by the
parallel `codex/merge-antigravity-20260630` worktree and is intentionally not
included here.

## Files

- `STATUS.md`
- `PLAN.md`
- `app/api/policy/route.ts`
- `src/lib/policy-null-stripping.ts`
- `test/policy-clear-nulls.test.ts`
- `docs/rollouts/2026-06-30-policy-route-export-fix.md`

## Verification

- `npm run lint` - pass, 0 errors / 254 existing warnings.
- `npx tsc --noEmit` - pass.
- `npm test` - pass, 165 files / 1577 tests.
- `npm run build` - first rerun failed with host `ENOSPC` while writing
  `.next/trace`; after clearing this worktree's generated `.next` output and
  Homebrew download cache, rerun passed. Route table includes `/api/policy`.

## Follow-ups

- Merge this fix before retrying the production deploy.
- Account for the parallel Antigravity branch only after it is verified/merged.
