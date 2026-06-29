# 2026-06-29 - Dependabot PostCSS Override Fix

## Summary

Changed the top-level `postcss` npm override from a literal range to npm's
`"$postcss"` direct-dependency reference so Dependabot can update the direct
PostCSS devDependency without npm `EOVERRIDE` failures. The Axios security
override remains in place.

## Why

The Dependabot updater failed on main while trying to evaluate
`postcss@8.5.16`:

```text
npm error code EOVERRIDE
npm error Override for postcss@8.5.16 conflicts with direct dependency
```

`postcss` is already a direct devDependency, and npm requires direct-dependency
overrides to match the direct dependency spec exactly. Dependabot tests concrete
new versions during updates, so the literal override range made routine PostCSS
updates unresolvable. The `$postcss` reference keeps transitive PostCSS pinned to
the direct devDependency while remaining compatible when Dependabot changes that
direct dependency.

## Files

- `package.json`
- `docs/ops-observability-security.md`
- `docs/rollouts/2026-06-19-ops-observability-security.md`
- `docs/rollouts/2026-06-29-dependabot-postcss-override.md`
- `PLAN.md`
- `STATUS.md`

## Verification

To be run after the initial commit/push:

```bash
npm install postcss@8.5.16 --package-lock-only --dry-run=true --ignore-scripts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Follow-ups

- Leave PostCSS as a direct devDependency and keep the transitive override in
  npm's direct-dependency-compatible `$postcss` form.
