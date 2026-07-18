# 2026-07-18 - Coolify CI runner routing

## Summary

Routed GitHub Actions jobs that still used GitHub-hosted `ubuntu-latest` onto the online Coolify
Hetzner CI runner label set: `[self-hosted, socratic-ci]`.

## Why

Current open PR checks are failing before runner assignment: job metadata shows `runner_id=0`, no
steps, and missing log blobs. The repo has two online Coolify runners (`socratic-ci`,
`socratic-deploy`) and the old Mac runner (`trading-live-mac`) is offline. Required PR gates need to
run on the available Coolify CI runner so auto-merge can proceed.

## Files

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/security.yml`
- `.github/workflows/shared-package-pin-check.yml`
- `.github/workflows/codex-autofix.yml`
- `.github/workflows/sentry-ci-report.yml`
- `.github/workflows/cleanup-caches.yml`
- `.github/workflows/effort-issues-sync.yml`
- `.github/workflows/_merge-shepherd-impl.yml`
- `.github/actionlint.yaml`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Verification

Passed:

```bash
ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].each { |f| YAML.load_file(f); puts "ok #{f}" }'
```

Runner inventory:

```text
coolify-hetzner-socratic    online  labels: self-hosted,Linux,X64,socratic-deploy
coolify-hetzner-socratic-ci online  labels: self-hosted,Linux,X64,socratic-ci
trading-live-mac            offline labels: self-hosted,macOS,trading-live,ARM64
```

## Follow-ups

After this workflow-only PR lands, rerun checks on PRs #1728, #1733, #1735, #1736, #1737, and #1738.
They already have zero unresolved review threads and auto-merge armed.
