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

The branch push also exposed a pre-job workflow validation failure in `merge-shepherd.yml`. Its
local reusable-workflow reference used the invalid form `./path.yml@main`; local references cannot
carry an `@ref`. The caller now uses `./.github/workflows/_merge-shepherd-impl.yml`, which is already
resolved from the default branch for `workflow_dispatch`.

The first full verify then reached `npx tsc --noEmit` and aborted at Node 24's default ~1 GiB heap
limit (`FATAL ERROR: Ineffective mark-compacts near heap limit`) inside the 2 GiB runner container.
A 1536 MiB heap let TypeScript proceed, but Playwright's Next build then exhausted that ceiling. The
dedicated `socratic-ci` container is now capped at 3072 MiB and heavy verify/Playwright jobs set
`NODE_OPTIONS=--max-old-space-size=2560`. The runner retains `cpu_shares=256`, `cpus=2.5`, and
`oom_score_adj=600`, plus single-runner serialization; `vitest.config.ts` already fixes
`maxWorkers: 1`.

With memory fixed, Playwright's Next build compiled in 2.8 minutes but the server did not reach
`/api/health` before the existing 240-second `webServer.timeout`. The timeout is now 600 seconds
when `CI` is set and remains 240 seconds locally. This accommodates the runner's intentionally low
CPU share without weakening the smoke assertions or hiding a failed server start.

Codex review then found that the `pull_request_review`-triggered autofix job could admit a fork PR to
the persistent runner before checkout and before the write token/model secret were consumed. Its
job-level condition now requires `github.event.pull_request.head.repo.full_name ==
github.repository` for bot-triggered reviews. Maintainer `workflow_dispatch` remains available.

Repeated final-head checkouts then exposed a lifecycle mismatch rather than a GitHub cancellation:
the runner image was configured with `EPHEMERAL=1`, but Coolify's Compose service used
`restart: always`. The image's documented fully-ephemeral pattern requires removing the container
after each job; Docker restart reused the same writable container layer, so a canceled checkout left
`/_work/Socratic.Trade/Socratic.Trade/.git` with no valid `HEAD` for every later registration. The
Socratic CI service now wraps `/entrypoint.sh` with a hardcoded, bounded cleanup of `/_work` before
each registration, then execs the image's normal runner command. No host or persistent volume is
mounted there. The first post-change registration completed checkout and the shared-package pin
check successfully, then re-registered with a new runner ID.

During production follow-through, the Coolify application was found configured on
`agent/ag-recovery-v48-migration` instead of `main`, with an empty deployment list. The application
was patched back to `git_branch=main` with auto-deploy enabled. No manual deployment was triggered;
the running release stayed healthy at `70a2a39d` pending protected merges and webhook-driven deploy.

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
- `.github/workflows/merge-shepherd.yml`
- `.github/actionlint.yaml`
- `playwright.config.ts`
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

Production configuration verification:

```text
socratic-trade-prod status=running:healthy git_branch=main
release=70a2a39d db=ok scheduler=current litestream=replicating
```

Additional verification:

```bash
git diff --check
ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].each { |f| YAML.load_file(f) }'
actionlint .github/workflows/_merge-shepherd-impl.yml .github/workflows/ci.yml \
  .github/workflows/merge-shepherd.yml \
  .github/workflows/cleanup-caches.yml .github/workflows/codex-autofix.yml \
  .github/workflows/e2e.yml .github/workflows/effort-issues-sync.yml \
  .github/workflows/security.yml .github/workflows/sentry-ci-report.yml \
  .github/workflows/shared-package-pin-check.yml
```

Coolify runner lifecycle receipt:

```text
pre-fix checkout: ambiguous argument 'HEAD'; Unable to clean or reset the repository
post-fix check-pin: checkout success; comparison success; job success (3m31s)
next registration: socratic-ci runner id 88 -> 89
```

Local verification limitation: `NODE_OPTIONS=--max-old-space-size=3072 npx tsc --noEmit` could not
run in this workflow-only worktree because project dependencies were not installed; `npx` reported
`This is not the tsc command you are looking for`. The authoritative Coolify `verify-hosted` job on
the immediately preceding head passed lint, TypeScript, the full unit suite, and the production
build. The new head must repeat that hosted gate before merge.

## Follow-ups

After this workflow-only PR lands, rerun checks on PRs #1728, #1733, #1735, #1736, #1737, and #1738.
They already have zero unresolved review threads and auto-merge armed.
