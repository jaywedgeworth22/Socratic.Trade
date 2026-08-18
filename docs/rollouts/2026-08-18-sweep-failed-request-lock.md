# 2026-08-18 — Sweep-failed orphan must not lock Manual Run once

## Context & Objective

#2845 is already merged and live (`d4299bec`).  After that deploy, Roth `strategy_runs` `0e5ccd66-8a1b-467f-a5f1-0aa9bd8a77f4` was stale-swept **failed** at `2026-08-18T22:13:05Z` (0 LLM; summary `Process restarted mid-run — marked failed by stale-run sweep (started at 2026-08-18T21:42:29.623Z)`).  Its `strategy_run_requests` row stayed `status=running`.  A 5:14pm CT Manual Run once then returned 502 and wrote no new `strategy_runs` row.  Trading Ops will not click again until that lock is gone.

This change couples request status to the run write path so a sweep-failed orphan cannot leave the next Manual Run once blocked.

## Changes Made

Manual Run once (`POST /api/strategy/run`) calls `queueStrategyRunRequest` then `processPendingStrategyRunRequests`.  The request UUID is passed through as `runId`, so `strategy_run_requests.id === strategy_runs.id`.  Claim sets the request to `running`.  The worker only marked it `completed`/`failed` after `runStrategyOnce` returned.  `queueStrategyRunRequest` dedupes if any request for that `userId` is still `queued` or `running`.

`markStaleRunningRuns` only updated `strategy_runs`.  After a process swap the worker never wrote the request terminal status, so the leftover `running` request blocked every later click (no new run row).  Same Roth pattern earlier: `2666cf3e` swept 19:08Z, `8e243fdd` swept 2026-08-17.

The 5:17pm CT 503 "no available server" then 200 on the same sha `d4299bec` / `processStartedAt` 22:06:43Z is a brief origin blip, not a new swap and not the lock itself.

Fix (write-path coupling, not queue-time hide):

- After a sweep successfully fails a `strategy_runs` row, close the matching open request (`queued`/`running` → `failed`) with the same sweep summary.
- On the same sweep tick, close any open request whose matching `strategy_runs` row is already terminal.  That is what clears live `0e5ccd66` after merge without requiring another click.  The scheduler already runs `markStaleRunningRuns` every 60s before the leader gate.
- `finishStrategyRun` also closes a matching open request (`failed` → request `failed`; skip/completed → request `completed`), covering worker death after the run row is finished.
- A `queued`/`running` request older than the 30-minute stale window with **no** `strategy_runs` row is marked failed.  Fresh queued rows (the live queue) are left alone.

Do not import `strategy-run-requests.ts` from `db-execution.ts` (cycle: requests → `strategy.ts` → `finishStrategyRun`).

- `src/lib/db-execution.ts`
- `src/lib/strategy-run-requests.ts`
- `src/lib/scheduler.ts`
- `test/stale-running-runs.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-sweep-failed-request-lock.md`

## Decisions & Trade-offs

- Root-caused from the live orphan + the request/run id share + queue dedupe.  Did not guess a missing-credential or #2845 regression into the patch.
- Did not make `queueStrategyRunRequest` ignore a `running` request.  That would hide the failure and leave the orphan row lying.
- Did not add UI error copy or owner notes.  Multi-user: each user's open request is independent; user A's orphan does not block user B; heal only closes the mismatched request id.
- Heal of already-terminal mismatches is immediate (no second 30-minute wait).  That is the live lock.
- Did not merge, deploy, or bounce Coolify.  Did not touch #2841, #2840, #2812, or strategy picks.

## Verification State

Focused commands (full suite not re-run; leftover #2845 wrap-up stopped):

```bash
npx vitest run test/stale-running-runs.test.ts
# Test Files  1 passed (1)
# Tests  10 passed (10)

npx tsc --noEmit   # exit 0
npm run lint       # 0 errors, grandfathered warnings only
```

PR: https://github.com/jaywedgeworth22/Socratic.Trade/pull/2847

## Next Steps & Blockers

- Do not merge from this seat.  After merge, the next scheduler tick closes live `0e5ccd66` without a click.
- Do not bounce Coolify to clear the lock.
- #2841 stays held.

## Zero-Code Findings

The 502-with-no-new-run click matches queue dedupe on the leftover `running` request (and/or a brief origin 502/503 before insert).  The durable lock is the open request, not the already-failed `strategy_runs` row.
