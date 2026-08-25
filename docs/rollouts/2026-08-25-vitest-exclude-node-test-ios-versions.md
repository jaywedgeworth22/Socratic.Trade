# 2026-08-25 -- exclude node:test ios-fleet suite from vitest

## Context & Objective

PR #3091 seeded fleet version publish from the live remote and added `scripts/ios-fleet/publish-ios-versions.test.mjs` as a `node:test` suite.  That file is meant to run via `node --test` (already added in `.github/workflows/ci.yml`).  Vitest's default `**/*.test.mjs` include still loaded it, so `verify-hosted` failed with "No test suite found" after 683 other files passed, and the `verify` gate then failed because hosted failed.

## Changes Made

Keep the publisher on `node --test`.  Tell vitest to ignore `scripts/**/*.test.mjs` the same way `reference/**` already hides other `node:test` files.

- `vitest.config.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-25-vitest-exclude-node-test-ios-versions.md`

## Decisions & Trade-offs

- Did not convert the suite to vitest.  #3091 already chose `node --test` and wired that command in CI.  Conversion would duplicate runners and hide the script-level contract the file is written for.
- Exclude glob is `scripts/**/*.test.mjs`, not a single filename, so a later script-level `node:test` file does not break `npm test` the same way.  There is only one such file today.

## Verification State

- `node --test scripts/ios-fleet/publish-ios-versions.test.mjs` — 4/4
- `npx vitest run scripts/ios-fleet/publish-ios-versions.test.mjs` — exits 1 "No test files found" with the new exclude in the exclude list (no "No test suite found")
- `npx vitest list` filtered for `publish-ios-versions` — absent (`not-collected`)
- `npm run lint` — exit 0 (errors only; existing warning backlog unchanged)
- `npx tsc --noEmit` — exit 0
- `npm run build` — Next.js 16.3.1 webpack build succeeded
- Local `npm test` still running in this environment; hosted CI already proved 7591 tests green aside from this one file.  `npx vitest list` is the collection proof.

## Next Steps & Blockers

Land this exclude onto #3091 (or merge this PR instead) so `verify` / `verify-hosted` can go green.  Congress.Trade still vendors the unguarded publisher; that is unchanged.

## Zero-Code Findings

Hosted job 97644546430: 7591 tests passed, 1 file failed (`publish-ios-versions.test.mjs`, "No test suite found").  Gate job 97647400123 failed only because `HOSTED_RESULT=failure`.
