# 2026-06-30 — Shared dependency via GitHub Packages (PR #279) + review fixes

## Summary

PR #279 switches `@jaywedgeworth22/congress-trading-shared` from a git/SSH-ref
install to the private **GitHub Packages** registry (`.npmrc`, `package.json`,
`package-lock.json`, and the `npm-ci-with-shared-deps.sh` helper). This rollout
note records the migration plus the follow-up fixes for the three Codex review
threads on the PR.

## Review follow-up (Claude)

- **P1 — production token leak via PM2 `--update-env` (`deploy.yml`).**
  `NODE_AUTH_TOKEN` was a job-level env var, so it remained in the shell through the
  `pm2 restart "$APP" --update-env` step (install + build + restart are one step),
  leaking the GitHub Packages token into the long-running production process's
  environment where runtime code could read it. Fix: `unset NODE_AUTH_TOKEN`
  immediately after `npm ci`, before build/restart. The token is only needed for the
  install.
- **P2 — preview sync had no package auth (`npm-ci-with-shared-deps.sh`, `sync-previews.yml`).**
  The helper only emitted npm.pkg.github.com auth when `NODE_AUTH_TOKEN` was set, but
  `sync-previews.yml` exported only `GITHUB_TOKEN`, so the first main push with the new
  lockfile would run `npm ci` unauthenticated and beta/agent preview worktrees would
  fail to refresh. Fix: the helper now falls back to `GITHUB_TOKEN` when
  `NODE_AUTH_TOKEN` is unset, and `sync-previews.yml` gains `packages: read`.
- **P2 — wrong token preferred for package installs (`ci.yml`, also `e2e.yml`, `deploy.yml`).**
  The chain `GH_PACKAGES_TOKEN || GH_PAT || GITHUB_TOKEN` preferred the Codex-Autofix
  PAT (`GH_PAT`, repo + workflow scope, **no** `read:packages`) over the packages-scoped
  job `GITHUB_TOKEN`, so in the common setup where only `GH_PAT` exists, installs would
  403. Fix: drop `GH_PAT` from the package-auth chain in all three workflows →
  `GH_PACKAGES_TOKEN || GITHUB_TOKEN`.

## Files

- `.github/workflows/deploy.yml` — drop `GH_PAT` from `NODE_AUTH_TOKEN`; `unset` after install.
- `.github/workflows/ci.yml` — drop `GH_PAT` from `NODE_AUTH_TOKEN`.
- `.github/workflows/e2e.yml` — drop `GH_PAT` from `NODE_AUTH_TOKEN`.
- `.github/workflows/sync-previews.yml` — add `packages: read`.
- `scripts/npm-ci-with-shared-deps.sh` — fall back to `GITHUB_TOKEN`.

## Verification

- `bash -n scripts/npm-ci-with-shared-deps.sh` — pass.
- YAML diffs reviewed for indentation; full `verify` + `smoke` + `gitleaks` CI gates the merge.

## Follow-ups

- Confirm the `@jaywedgeworth22/congress-trading-shared` package grants `read` to the
  consuming repo so the job `GITHUB_TOKEN` (packages: read) can install it without a PAT.
