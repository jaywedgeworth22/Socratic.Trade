# 2026-07-18 - Coolify CI runner routing

## Summary

Routed GitHub Actions jobs that still used GitHub-hosted `ubuntu-latest` onto the dedicated Coolify
Hetzner CI lane: `[self-hosted, socratic-ci]`. Recovered the exited runner containers through the
Coolify service API and made the Gitleaks action compatible with the self-hosted workspace layout.

## Why

Current open PR checks are failing before runner assignment: job metadata shows `runner_id=0`, no
steps, and missing log blobs. The repo has Coolify Linux runners and the old Mac runner
(`trading-live-mac`) is offline. A first rerun showed both Socratic runner containers exited while
the Coolify service was `degraded:unhealthy`; restarting service `github-runner`
(`uhz1yhxevabvbf9eblxo4t8z`) recovered all four fleet runners. The transient runner IDs were normal
ephemeral registrations, not evidence that CI should consume the `socratic-deploy` lane. Keeping
jobs on `socratic-ci` serializes them and preserves deploy capacity.

The first successful self-hosted Gitleaks scan found no leaks but failed while uploading its optional
SARIF artifact: the action used `/root` as its artifact root while the result lived under `/_work`.
`GITLEAKS_ENABLE_UPLOAD_ARTIFACT=false` keeps the required scan and avoids that incompatible optional
upload.

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

Follow-up observation after first PR run: `socratic-ci` re-registered repeatedly, then disappeared
from the GitHub runner list while checkout jobs were still in progress. The Coolify API then showed
both Socratic containers as `exited`; `POST /api/v1/services/uhz1yhxevabvbf9eblxo4t8z/restart`
returned `Service restarting request queued`, and both runners re-registered online. Production
health remained `ok` with DB `ok`, scheduler current, and Litestream `replicating`.

Additional verification:

```bash
git diff --check
ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].each { |f| YAML.load_file(f) }'
actionlint .github/workflows/_merge-shepherd-impl.yml .github/workflows/ci.yml \
  .github/workflows/cleanup-caches.yml .github/workflows/codex-autofix.yml \
  .github/workflows/e2e.yml .github/workflows/effort-issues-sync.yml \
  .github/workflows/security.yml .github/workflows/sentry-ci-report.yml \
  .github/workflows/shared-package-pin-check.yml
```

## Follow-ups

After this workflow-only PR lands, rerun checks on PRs #1728, #1733, #1735, #1736, #1737, and #1738.
They already have zero unresolved review threads and auto-merge armed.
