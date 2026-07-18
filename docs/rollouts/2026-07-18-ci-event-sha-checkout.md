# CI event-SHA checkout pin

## Summary

Pinned the lightweight CI classifier and security checkout actions to `github.sha`, retaining
shallow and tag-free fetches. The classifier continues to fetch the base/head endpoint commits
explicitly for its changed-file comparison.

## Why

The first shallow-checkout recovery reduced object count but the persistent self-hosted workspace
still traversed broad refs during checkout. Pinning the event SHA makes the checkout target
explicit and bounds startup work before the required gates execute.

## Files

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/security.yml`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-18-ci-event-sha-checkout.md`

## Verification

- `git diff --check` (pending before commit)
- Ruby YAML parse for all changed workflow files (pending before commit)

## Follow-ups

Open as a stacked PR against the Coolify CI routing branch and rerun the required checks.
