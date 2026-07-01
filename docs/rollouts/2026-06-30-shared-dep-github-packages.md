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

## Round 2 (Codex re-review)

- **Preview-sync token leak (same class as the deploy.yml P1):** `scripts/sync-preview-lanes.sh`
  restarted each preview with `pm2 restart --update-env` while `GITHUB_TOKEN` was still in the
  environment, so adding `packages: read` would have handed a package-capable token to every preview
  PM2 process. Now runs the restart via `env -u GITHUB_TOKEN -u NODE_AUTH_TOKEN pm2 restart ...` so
  the app never inherits the token (git fetch + npm ci above still use it).
- **ASCII-only script rule:** the fallback comment I added to `scripts/npm-ci-with-shared-deps.sh`
  used em dashes, violating the AGENTS.md `scripts/*.sh` ASCII-only rule; rewritten to ASCII.
- **Handoff docs:** `STATUS.md` and `PLAN.md` still described the old git+`220677a`-pin + deploy-key
  model; both now record the GitHub Packages registry switch (this PR).

## Follow-ups

- Confirm the `@jaywedgeworth22/congress-trading-shared` package grants `read` to the
  consuming repo so the job `GITHUB_TOKEN` (packages: read) can install it without a PAT.
- **Tokenless fresh-clone install (acknowledged):** switching the shared dep to a private registry
  means a bare `git clone` with **no** `NODE_AUTH_TOKEN`/`GITHUB_TOKEN` at all now fails `npm ci`
  (403) — inherent to the registry migration. CI/Actions and most cloud runners always provide
  `GITHUB_TOKEN`; for a truly tokenless local checkout the package README documents consuming the
  shared package from a git ref or local path. Follow-up: update the CLAUDE.md "no secrets required"
  cloud note to mention the package auth (or a git-ref fallback) for bare clones.
