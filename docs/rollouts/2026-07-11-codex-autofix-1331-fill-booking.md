# Codex autofix: broker-stop fill booking on pending-cancel success

**Date:** 2026-07-11  
**Branch:** `claude/codex-autofix-1331-fill-booking`  
**PR:** #____  

## Summary

Addressed a post-merge Codex review finding on PR #1331. When a `pending_cancel` broker protective stop had already partially filled and the next retry successfully cancelled the remaining shares, the success path deleted the DB row without consulting the freshly fetched `orders` snapshot — so the executed broker-held stop shares were never inserted into `fill_events`.

## What changed

**`src/lib/broker-protective-stops.ts`** — In section 1's pending-cancel retry loop, after a successful `cancelEquityOrder()`, added the same pre-cancel fill check that the disabled-teardown path (section 0) already performs: look up the order in the caller's `orders` snapshot, check `hadExecutedFill()`, and if so book the fill via `bookBrokerHeldStopFill()` and add the symbol to `filledRecoverySymbols` so section 4 defers re-placement (same stale-position concern that the disabled-teardown path handles).

No other files touched.

## Why

Without this, a partially-filled broker stop whose remaining shares are cancelled would silently lose the executed fill from P&L, learning, and activity records. The disabled-teardown path (feature turned off) already handled this correctly — this is a simple mirror of that pattern.

## Verification

- `npx tsc --noEmit` — 0 errors
- `npm test` — 3488 passed (318 files)
- `npm run build` — clean build
- `npm run lint` — 0 errors (378 grandfathered warnings)

## Follow-ups

The PR #1331 review thread has two remaining unresolved Codex items (P2) that were not addressed in this fix:
1. "Allow risk-reducing stop cleanup under live opt-out" — `ALLOW_LIVE_TRADING=false` early return skips cleanup
2. "Recover broker-stop fills while stopped" — fill booking gated on `running`
