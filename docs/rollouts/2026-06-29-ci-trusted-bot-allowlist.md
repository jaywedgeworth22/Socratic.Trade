# 2026-06-29 — CI trusted-bot allowlist for cursor[bot] PRs

## Summary
- Updated the self-hosted PR guard in CI, Playwright Smoke, and Security to allow
  trusted same-repo bots (`cursor[bot]`, `dependabot[bot]`) while still blocking
  fork PRs and other bots.

## Why
- PR #249 failed all three required checks (`verify`, `smoke`, `gitleaks`) at the
  "Refuse untrusted PR source" step with `actor="cursor[bot]"`.
- The guard was added 2026-06-29 to keep untrusted fork/bot PRs off the
  production Mac runner, but it also blocked Cursor Cloud agent pushes on
  same-repo `cursor/*` branches.
- First CI run on the PR passed when triggered by `jaywedgeworth22`; subsequent
  `cursor[bot]` pushes failed before checkout.

## Files
- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/security.yml`
- `STATUS.md`
- `docs/rollouts/2026-06-29-ci-trusted-bot-allowlist.md`

## Verification
- Bash allowlist logic: `cursor[bot]` passes, `evil[bot]` blocked (quoted case patterns).
- `npm run lint`, `npx tsc --noEmit`, `npm test` — run before push.

## Follow-ups
- Re-run PR #249 checks after push; expect all three jobs to proceed past the guard.
