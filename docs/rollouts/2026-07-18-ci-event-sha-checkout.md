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

- `git diff --check`
- `ruby -e 'require "yaml"; %w[.github/workflows/ci.yml .github/workflows/e2e.yml .github/workflows/security.yml].each { |f| YAML.load_file(f) }'`
- `actionlint .github/workflows/ci.yml .github/workflows/e2e.yml .github/workflows/security.yml`

## Follow-ups

PR #1742 merged into `codex/coolify-ci-runner-routing` as `b63fc78e`. Final gate, merge, and
deployment verification follow parent PR #1739.
