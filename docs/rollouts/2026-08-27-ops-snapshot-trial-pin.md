# 2026-08-27 — Pin ops-snapshot Pinecone trial calendar

## Context & Objective
`verify-hosted` on #3110 (`fix/ios-ship-cfbundleversion`) failed `test/ops-snapshot.test.ts` at `snapshot.pineconeIngest.trial.active === true`.  The iOS CFBundleVersion commit did not touch this path.  The default trial calendar `PINECONE_CURRENT_TRIAL_ENDS_AT` is `2026-08-27T00:00:00.000Z`, and `buildOpsSnapshot` calls `pineconeTrialState(Date.now())`.

## Changes Made
Pinned `PINECONE_TRIAL_ENDS_AT` for the ops-snapshot case that asserts the in-window path, matching sibling trial tests that already pin the env or freeze `now`.  Used a far date so the case does not time-bomb again in a few days.

- `test/ops-snapshot.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-27-ops-snapshot-trial-pin.md`

## Decisions & Trade-offs
Did not skip the case: the soft-429 dependency asserts are still useful.  Did not change production snap behavior.  Did not restack onto #3110; this is a standalone main fix so every open PR can pick it up.

## Verification State
- `npx vitest run test/ops-snapshot.test.ts`
- `verify` on #3110 is a gate over `verify-hosted`; it failed only because hosted failed

## Next Steps & Blockers
Merge this PR to `main`.  #3110 should merge `origin/main` (or wait for this squash) so its hosted gate is not blocked by the calendar.

## Zero-Code Findings
None.  This is a wall-clock test pin, not a flake.
