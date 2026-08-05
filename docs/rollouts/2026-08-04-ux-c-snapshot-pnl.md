# 2026-08-04 — UX PR-C1/C2 Dashboard snapshot cache + P&L path

## Context & Objective

UX program Wave C: reduce dashboard load cost (PR-C1 short TTL + singleflight cache)
and keep P&L / performance assembly honest under multi-account keys (PR-C2 adjacency).

## Changes Made

- `src/lib/dashboard-snapshot-cache.ts` — per-process TTL (~10s, env-clamped) + singleflight;
  cache key = `userId + accountNumber + connectedAccountId`; invalidate on policy/mobile writes.
- `getDashboardSnapshot` / performance / mobile-api / db-profiles wire cache + invalidation.
- Tests: `test/dashboard-snapshot-cache-pnl.test.ts`.

### Touched files

- `src/lib/dashboard-snapshot-cache.ts` (new)
- `src/lib/dashboard.ts`, `src/lib/performance.ts`, `src/lib/mobile-api.ts`, `src/lib/db-profiles.ts`
- `test/dashboard-snapshot-cache-pnl.test.ts` (new)
- `docs/rollouts/2026-08-04-ux-c-snapshot-pnl.md`

## Decisions & Trade-offs

- Short TTL is a safety net when write-path invalidation is incomplete; SSE/poll still
  drive freshness after real changes.
- Broad per-user invalidation on policy writes (all accounts) is intentional given short TTL.

## Verification State

Landing operator: skipped full local `npm test` (host load). CI `verify` is the gate.
Money-path-adjacent: keep an eye on multi-account cache key tests in CI.

## Next Steps & Blockers

- Merge via auto-merge when `verify` green.
- PR-C3 TableVirtuoso is a separate PR.
