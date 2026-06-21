# Pending CI workflows (blocked on token scope)

These three GitHub Actions workflows are the **only** non-redundant artifact found
across every agent branch and stash during the 2026-06-20 loose-ends sweep (see
`docs/rollouts/2026-06-20-loose-ends-cleanup.md`). They live here instead of
`.github/workflows/` because the active GitHub token lacks the `workflow` OAuth
scope, so pushing them under `.github/workflows/` is rejected by GitHub.

- `ci.yml` — `npx tsc --noEmit` + `npm test` + `npm run build` on PR/push.
  NOTE: pins Node 24 / `npm ci`; confirm that matches the local toolchain first.
- `e2e.yml` — Playwright smoke (`npm run test:e2e`); the script and
  `test/e2e/dashboard-smoke.spec.ts` already exist on `main`, so it is plug-and-play.
- `security.yml` — gitleaks secret scan; pairs with the existing `.gitleaks.toml`
  and `.pre-commit-config.yaml`. Confirm `gitleaks/gitleaks-action@v3` is current.

## To install
1. Re-scope the token: `gh auth refresh -h github.com -s workflow`
2. Move the files: `git mv ci-pending/*.yml .github/workflows/` then remove this dir
3. Sanity-check `ci.yml`'s Node version, then commit + push.
