# 2026-08-21 — Scan card tap + honest iOS last/next run

## Context & Objective

Owner: tapping anywhere on a market-scan stock card should open company info, not just the ticker.  Company name on the iOS scan card should read as darker black than industry.  Roth IRA Home showed "not scheduled" for both Last Run and Next Run while Autopilot was on.  Last run is a completed stamp and must never reuse cadence copy.

## Changes Made

Scan cards (iOS `ScanRow` and the website phone card list) are now a full-card hit target.  The watchlist star stays its own control.  iOS prints company name in primary/semibold and keeps industry (or sector) in secondary caption.

`getSchedulerState` no longer returns a blank in-memory clock after a restart or after the cash close.  Last run falls back to `strategy_runs.started_at`.  While `systemState === "active"`, next run is the live cadence stamp, else last-run + cadence, else the next session open.  The tick writes that next-session stamp when the market is closed instead of leaving `nextRunAt` null.

iOS Last Run uses `AppFormat.lastRun` (`never` when missing).  Next Run uses `AppFormat.nextRun` (`not scheduled` only when autonomy is off).

Touched files:

- `src/lib/scheduler-presentation.ts`
- `src/lib/scheduler.ts`
- `src/lib/dashboard.ts`
- `src/lib/market-hours.ts`
- `src/lib/mobile-scan.ts`
- `app/console/ui/symbol-drilldown.tsx`
- `app/console/scan/scan-table.tsx`
- `ios/SocraticTrade/ScanView.swift`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `test/scheduler-presentation.test.ts`
- `test/market-hours.test.ts`
- `test/mobile-scan.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `PLAN.md`
- `docs/rollouts/2026-08-21-ios-scan-card-schedule.md`

## Decisions & Trade-offs

Did not add `strategyRuns` to the mobile snapshot.  Filling `scheduler.lastRunAt` / `nextRunAt` at the existing field keeps TestFlight binaries working once the API is live.  The watchlist star sits on the trailing edge of the iOS card so it is not a nested button inside the sheet control.  Next-session math uses 9:30 ET (or 4:00 ET when extended hours are on).  Event-only accounts with no fallback interval still have a null next run.

## Verification State

Commands and results are recorded after the local gate in this same note.

## Next Steps & Blockers

iOS binary change ships only via `scripts/ios-ship-testflight.sh`.  Last/next run honesty on TestFlight 1.0.x still needs the API deploy (weekday RTH latch applies).  Cloud VM cannot run `xcodebuild`; Mac `ios-build.yml` is the Swift compile of record.

## Zero-Code Findings

The iOS "not scheduled" pair was two bugs stacked: `AppFormat.relative` used cadence copy for a missing last-run stamp, and `getSchedulerState` read only the in-memory account clock, which hydrates `nextRunAt: null` on boot and left it null after the cash close.
