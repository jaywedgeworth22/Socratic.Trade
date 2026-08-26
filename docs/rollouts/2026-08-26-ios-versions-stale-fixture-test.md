# 2026-08-26 -- ios-fleet publisher test must not pin live versions.json

## Context & Objective

#3091 guards `publish-ios-versions.sh` so a hosted TestFlight ship cannot PUT a stale vendored snapshot over the shared fleet manifest.  Its node:test suite then pinned the live in-repo `scripts/ios-fleet/ios-app-versions.json` as "must stay the failing fixture" (`!net.dealdex`, Usage Client 1.0.8, Usage Local 1.0.7, Autorotate 1.0.1).  That pin is true on the #3091 branch (2026-08-21 snapshot) and false on current `main` after #3102 added `net.dealdex`.  GitHub Actions checks out the pull_request merge commit, so `verify-hosted` failed and the required `verify` gate followed.

## Changes Made

Replace the live-file pin with a constructed 2026-08-21 stale snapshot passed as `--base-json`.  The test now proves the hazard (publish from that base omits `net.dealdex` and keeps the rolled sibling versions) without depending on whatever later ships write into the vendored cache.

- `scripts/ios-fleet/publish-ios-versions.test.mjs`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-26-ios-versions-stale-fixture-test.md`

## Decisions & Trade-offs

- Did not freeze `ios-app-versions.json` on `main` or revert #3102.  That file is a local cache other ships refresh; pinning its exact keys is a merge-commit landmine.
- Kept the other three node:test cases (multi-app remote merge, empty-base refuse, script-source guards).  The vitest exclude of `scripts/**/*.test.mjs` from #3095 stays; this suite still runs via `node --test` in `ci.yml`.
- Did not change the publisher script itself.

## Verification State

- `node --test scripts/ios-fleet/publish-ios-versions.test.mjs` -- 4/4 on the branch snapshot
- Same 4/4 after overlaying `origin/main`'s `ios-app-versions.json` (the merge-commit shape that failed CI)
- `npm run lint` -- 0 errors (grandfathered warnings only)
- `npx tsc --noEmit` -- exit 0
- `npm run build` -- Next.js 16.3.1 webpack build succeeded
- Full local `npm test` not used as a gate: this file is excluded from vitest (`scripts/**/*.test.mjs`); the Cloud VM suite hit unrelated network/timeout flakes before finishing

## Next Steps & Blockers

- Land this branch so #3091's publisher guard can go green against current `main`.
- Congress.Trade still vendors the unguarded publisher.  Not fixed here.

## Zero-Code Findings

CI job 98306835792 (`verify-hosted` on `ee560bc2`) failed only in `stale in-repo snapshot would drop net.dealdex and roll siblings` with `AssertionError: vendored snapshot must stay the failing fixture`.  The other three publisher tests passed.  `verify` (98307125600) is the hosted-result gate and failed solely because hosted failed.
