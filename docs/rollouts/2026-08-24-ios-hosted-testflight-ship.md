# 2026-08-24 -- hosted macos-latest TestFlight ship (in-repo ios-fleet)

## Context & Objective

Owner: `xcodebuild` is not a local command.  Compile and TestFlight run on GitHub-hosted `macos-latest` only.  Other seats were restarting the retired Mac runner / local Xcode.  #3083 switched `runs-on` but left the ship wrapper exec'ing `/Users/jay/apps/ios-fleet/ship-testflight.sh`, which does not exist on hosted runners, so every `ios-ship` tick failed in about 15s.  This change follows the Congress.Trade hosted protocol so #3028 (already on `main`) can actually reach TestFlight.

## Changes Made

Vendored the fleet ship tooling in-repo (CT pattern).  Hosted `ios-ship.yml` now imports signing from GitHub Actions secrets, restores `~/.cache/ios-fleet` across runs, and execs `scripts/ios-fleet/ship-testflight.sh`.  Durable docs now forbid local `xcodebuild` and Mac-runner restarts.

- `.github/workflows/ios-ship.yml`
- `.github/workflows/ios-build.yml` (comments / fork note only)
- `scripts/ios-ship-testflight.sh`
- `scripts/ios-fleet-pin.sh`
- `scripts/ios-fleet.sha256`
- `scripts/ios-appstore-gm-prepare.sh`
- `scripts/ios-fleet/*` (vendored from Congress.Trade)
- `AGENTS.md`
- `ios/CLAUDE.md`
- `ios/SocraticTrade/README.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-24-ios-hosted-testflight-ship.md`

## Decisions & Trade-offs

- Followed Congress.Trade: in-repo `scripts/ios-fleet/`, `ios-appstore-gm-prepare.sh`, GitHub secret names `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8` / `IOS_DIST_P12_BASE64` / `IOS_DIST_P12_PASSWORD`.  Did not mint a new App Store Connect key.  Copied the existing team credentials onto this repo (same team `CC8UTF7ATG`).
- `actions/cache` for `~/.cache/ios-fleet` so hosted cron ticks still see last-ship state.  Without it every 30-minute tick looks like "no prior ship" and would re-archive.
- Pin now hashes the in-repo copy, not `/Users/jay/apps/ios-fleet`.  Hosted runners have no Mac path.  `check-drift.sh` stays advisory when the Mac dir is absent.
- `apps.json` `socratic.marketingVersionDefault` set to `1.0.68` as the fallback train.  Live numbering still comes from App Store Connect `latest-build-seq` when ASC auth works.
- Posted `#agent-sync` so peer seats stop restarting local `xcodebuild` / the Mac runner.

## Verification State

- `bash scripts/ios-fleet-pin.sh --check`
- `bash scripts/test-ios-scheduled-ship-gate.sh`
- `python3` ASCII scan of new operator scripts (`ios-appstore-gm-prepare.sh` em dash replaced)
- `npm run lint` (exit 0)
- `npx tsc --noEmit` (exit 0)
- Hosted `ios-build.yml` `xcodebuild (unsigned)` SUCCESS on PR #3089 (`32792277819`)
- Hosted `verify-hosted` FAIL on `3493c341`: `test/sentry-ci-report-workflows.test.ts` still listed `iOS build (Mac runner)` / `iOS TestFlight ship (Mac runner)` after the YAML `name:` rename.  Fixed observer list + `CRON_SCHEDULES`; dropped the duplicate dict key.
- `npx vitest run test/sentry-ci-report-workflows.test.ts` after the observer fix
- Full `npm test` / `npm run build` remain the hosted `verify-hosted` lane (local Cloud VM flakes on network-bound suites)
- After merge: `gh workflow run ios-ship.yml`

## Next Steps & Blockers

- After merge: `gh workflow run ios-ship.yml` on `main`.  Confirm TestFlight processes a build that includes #3028 chrome (gear, bell, Admin tab).
- Peer seats: do not run local `xcodebuild`.  Do not re-register `mac-xcode26-socratic`.
- Website/Coolify: `scripts/**` is in watch_paths so this merge can auto-deploy the website image.  The vendored fleet scripts are not production Node.  Website behavior is unchanged.

## Zero-Code Findings

#3088's "TestFlight blocked" close-out was the wrong protocol.  The hosted runner is the ship path.  The missing piece was vendoring the fleet scripts + ASC import, not waiting for a Mac.
