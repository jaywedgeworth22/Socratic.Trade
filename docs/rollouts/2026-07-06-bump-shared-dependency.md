# Rollout: Shared Dependency Bump to ^1.3.0 and HTTPS Lockfile (2026-07-06)

## Summary
Bumped the `@jaywedgeworth22/congress-trading-shared` dependency version to `^1.3.0` and normalized the lockfile to use `git+https` instead of `git+ssh`.

## Why
This keeps the `agentic-trading` (Socratic.Trade) and `Congress.Trade` repositories synchronized, satisfying the `.github/workflows/shared-package-pin-check.yml` guard which requires both consumers of the shared package to pin the exact same semver tag. Using `git+https` in the lockfile fixes installation failures in tokenless CI environments.

## Files
- `package.json`
- `package-lock.json`

## Verification
- Ran `npm install` inside `agentic-trading`.
- Verified `package-lock.json` uses `git+https`.
- Committed and pushed the `agent/antigravity-bump-shared` branch to trigger a PR via `scripts/land.sh`.

## Follow-ups
- Merge the PRs in both repositories once CI checks pass.
