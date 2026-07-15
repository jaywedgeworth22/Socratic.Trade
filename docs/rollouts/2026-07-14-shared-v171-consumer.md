# 2026-07-14 - Immutable congress-trading-shared v1.7.1 consumer adoption

## Summary

Socratic.Trade now consumes `@jaywedgeworth22/congress-trading-shared` from the
immutable `v1.7.1` commit
`0bc26ab9311a396f3f6b5cba0fb54fa7558a42b4` instead of the former exact
`v1.6.0` commit `c4fcfb4423a11318bda8486ecf3dd6ab1783e87a`.
The same full SHA is present in the dependency manifest, npm `allowScripts`, and
the generated lockfile.

## Why

The old git dependency could clean-install as declarations without its declared
CommonJS and ESM runtime entries. The immutable `v1.7.1` release restores the
complete built package surface while retaining a commit-level, non-range pin.

## Files

- `package.json`
- `package-lock.json`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-14-shared-v171-consumer.md`

## Verification

Completed under Node 24:

- Confirmed public tag `v1.7.1` resolves to
  `0bc26ab9311a396f3f6b5cba0fb54fa7558a42b4`.
- Regenerated `package-lock.json` with `npm install --package-lock-only` using a
  fresh disposable npm cache.
- Ran `npm ci` with a second fresh disposable npm cache.
- Confirmed non-empty `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts`, and
  `dist/index.d.mts` artifacts.
- Confirmed `require("@jaywedgeworth22/congress-trading-shared")` and dynamic
  ESM import each expose 105 exports, including `CongressTradeClient` and
  `UsageTelemetryEventSchema`.
- Confirmed `npm ls` resolves package version `1.7.1` at the full immutable SHA.
- Re-ran lock-only resolution with another fresh cache and reproduced the shared
  package ref, version, resolved commit, and integrity fields. Retained the
  pre-existing `fsevents@2.3.2` development marker so this consumer bump does not
  carry unrelated npm lock-metadata churn.
- Exercised the new webhook HMAC helpers through the installed ESM surface,
  including the supported `sha256=` prefix and a mismatched-body rejection.
- Compared the installed runtime/declaration artifacts with the parallel
  Congress.Trade consumer lane: all four SHA-256 hashes match byte-for-byte.
  The two npm lock integrity strings differ because the git dependency is
  prepared/packed in different consumer trees; the delivered code and types do
  not differ.
- Parsed both npm JSON files and ran `git diff --check` successfully.
- Reconciled cleanly with `origin/main@3df405e6`, then repeated the Node 24.18.0
  fresh-cache install; the lockfile SHA-256 remained unchanged.
- `npm run lint`: exit 0 with 0 errors and 459 inherited warnings.
- `npx tsc --noEmit`: clean.
- `npm test`: 370 files / 4,172 tests passed in 558.95 seconds.
- `npm run build`: green with the real TypeScript phase and all 32 static pages.
  The emitted middleware-deprecation, generated-CSS, webpack-cache, and Sentry
  Edge-runtime warnings pre-exist this package-metadata-only change.

## Follow-ups

- Commit the green branch with the repository noreply identity.
- Land through `scripts/land.sh`, require protected hosted verification and squash
  merge, then confirm the automatic production rollout serves the exact merge SHA.
- Confirm production health keeps the DB, scheduler lease, Litestream replication,
  usage-monitor dependency, and Congress.Trade dependency green.
