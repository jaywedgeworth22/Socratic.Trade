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

- `git diff --check`
- `ruby -e 'require "yaml"; %w[.github/workflows/ci.yml .github/workflows/e2e.yml .github/workflows/security.yml].each { |f| YAML.load_file(f) }'`
- `actionlint .github/workflows/ci.yml .github/workflows/e2e.yml .github/workflows/security.yml`

## Follow-ups

PR #1741 merged into `codex/coolify-ci-runner-routing` as `c5ae4984`. Final gate, merge, and
deployment verification follow parent PR #1739.
