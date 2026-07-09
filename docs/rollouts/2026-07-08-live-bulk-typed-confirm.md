# 2026-07-08 - Live bulk approval typed-confirm flow

Branch: `codex/live-bulk-typed-confirm` (worktree `/Users/jay/.codex/worktrees/socratic-live-bulk-typed-confirm`).

## Summary

- Extended `/console/approvals` bulk approval to include selected LIVE proposals.
- LIVE bulk approval opens one aggregate typed-confirm sheet only when `policy.requireTypedConfirmation` is enabled.
- When typed confirmation is disabled, selected LIVE proposals approve with the same one-click bulk action as paper proposals.
- Bulk reject remains the existing inline one-click confirm path; no typed phrase was added there.
- Each selected proposal still submits through the existing per-item approve endpoint, so placed, blocked, and failed results stay row-honest.

## Why

#807 intentionally left LIVE proposals out of bulk approve. MONET confirmed the owner constraints before implementation:
bulk reject must stay one-click, LIVE bulk approve may ask for one aggregate typed phrase only when the owner-adjustable
`policy.requireTypedConfirmation` setting is on, and the implementation must keep using the current per-item approval
endpoint instead of inventing a new broker path.

## Files

- `app/console/approvals/page.tsx`
- `app/console/approvals/triage.ts`
- `test/approvals-triage-model.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-07-08-live-bulk-typed-confirm.md`

## Verification

```bash
git diff --check
node --check app/console/approvals/triage.ts
./node_modules/.bin/vitest run test/approvals-triage-model.test.ts
npm run lint
npx tsc --noEmit
npm test -- --reporter=dot --maxWorkers=2
npm run build
```

Passed:

- `git diff --check`
- `node --check app/console/approvals/triage.ts`
- Focused triage test: 1 file / 2 tests
- `npm run lint`: 0 errors, 353 grandfathered warnings
- `npx tsc --noEmit`: clean
- Full Vitest: 301 files / 3101 tests (low workers to avoid local resource SIGTERM)
- `npm run build`: passed with only the existing Sentry Edge-runtime warning

## Follow-ups

- If the product later wants server-native aggregate confirmation text, add a dedicated server contract; this branch intentionally keeps the existing per-item endpoint.
