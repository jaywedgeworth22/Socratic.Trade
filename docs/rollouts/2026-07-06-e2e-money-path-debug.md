# 2026-07-06: E2E Money-Path Test Debugging

## Summary
Fixed the `test/e2e-money-path.test.ts` to successfully run a mock live autonomous money path strategy.

## Why
The E2E test for the full money-path strategy flow was broken because it was not properly faking the `isTradingDay` behavior (so runs skipped execution due to the market being closed), its `manual` flag blocked the `decide` autonomous authority check, and the `ALLOW_LIVE_TRADING` environment variable was not set for the test `setupBrokerLiveAutonomous` (causing it to fail a safety live-capital pre-flight check).

## Files Touched
- `test/e2e-money-path.test.ts`

## Verification
```bash
npm run lint
npx tsc --noEmit
npm run build
npm test test/e2e-money-path.test.ts
```
All verifications ran successfully and the E2E money-path integration test passes, reaching a "placed" status.

## Follow-ups
Wire `congress-score-eval` go/no-go into the scan/scoring.
