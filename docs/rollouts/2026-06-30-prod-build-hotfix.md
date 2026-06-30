# 2026-06-30 - Production Build Hotfix

## Summary

- Repaired production after the PR #270 deploy left `trading` stopped.
- Moved `stripNullsDeep` out of `app/api/policy/route.ts` so the route module exports only valid Next route fields.
- Switched server-only crypto imports from `node:crypto` to `crypto` so the webpack build can compile the affected server/edge graph.
- Changed `npm run build` to `next build --webpack` so the automated deploy emits the root `BUILD_ID`, `routes-manifest.json`, `prerender-manifest.json`, and `required-server-files.json` files that the current PM2 `next start` runtime requires.

## Why

The self-hosted deploy for main commit `07085c91` failed during install, then a manual default `next build` completed but produced Turbopack artifacts without the root production marker files expected by `next start`. PM2 repeatedly restarted with `Could not find a production build in the '.next' directory`. A webpack build exposed and fixed the invalid route export and `node:crypto` import blockers, then produced the expected artifacts and let production boot.

The Antigravity strategy-review persistence work landed separately as PR #274. This branch only fixes production build/start repeatability.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/deployment.md`
- `docs/rollouts/2026-06-30-prod-build-hotfix.md`
- `package.json`
- `app/api/policy/route.ts`
- `src/lib/policy-null-stripping.ts`
- `src/lib/ops-auth.ts`
- `src/lib/recoverable-issue.ts`
- `src/lib/scheduler-lease.ts`
- `test/policy-clear-nulls.test.ts`

## Verification

- Live manual repair on `~/apps/trading-live`:
  - `npx next build --webpack` - pass.
  - `pm2 restart trading --update-env && pm2 save` - pass.
  - `curl -I http://127.0.0.1:4000/` - 307 to `/login`.
  - `curl -i http://127.0.0.1:4000/api/health` - 200, `{"ok":true,...}`.
  - `curl -I https://trading.jays.services/` - 307 to `/login`.
- Branch verification:
  - `npm run lint` - pass, 0 errors, 254 existing warnings.
  - `npx tsc --noEmit` - pass after freeing disposable worktree build/cache artifacts to resolve host `ENOSPC`.
  - `npm test` - pass, 165 files / 1,577 tests.
  - `npm run build` - pass.

## Follow-ups

- Revisit Turbopack production builds separately once the production start command is known to consume the new artifact layout.
