# CI shallow-checkout recovery

## Summary

Changed the lightweight CI classification and security workflows to avoid full-history/tag fetches
on the single Coolify self-hosted runner. Classification fetches the base/head endpoint commits
and compares their trees directly; security uses a shallow, tag-free checkout.

## Why

PR #1739's routing fix moved required checks onto the Coolify CI runner, but repeated full-history
checkout attempts consumed several minutes and caused classify jobs to be cancelled before the
dependent smoke job could run. The application checks were healthy; the failure was workflow
startup contention.

## Files

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/security.yml`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-18-ci-shallow-checkout.md`

## Verification

- `git diff --check` (pending before commit)
- YAML reviewed in the changed workflow blocks (pending hosted check)

## Follow-ups

Open a stacked PR against `codex/coolify-ci-runner-routing`; once merged, rerun the routing PR's
required checks and then resume the admin-console PR landing sequence.
