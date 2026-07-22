# Shared-package pin-check queue unblock — 2026-07-22

## Summary

Replaced the stale #1780 vehicle with a minimal workflow correction: the shared-package pin check
now runs on every pull request and installs Node 24 before its comparison script.

## Why

The current workflow's pull-request `paths` filter emitted no check for most PRs, and the check's
shell script invoked `node` before any setup-node step. Hosted run 29915655110 failed at line 102
with `node: command not found`; unrelated PRs could also be stranded with no pin status at all.

## Files

- `.github/workflows/shared-package-pin-check.yml`
- `test/ci-workflow-queue-safety.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-07-22-shared-package-pin-check-queue-unblock.md`

## Verification

Run the focused workflow-safety test, then the required hosted `verify` check before merge.

## Follow-ups

Close #1780 as superseded after this replacement merges; do not restore `check-pin` as a required
context until both consumers' shared-package pins are coordinated.
