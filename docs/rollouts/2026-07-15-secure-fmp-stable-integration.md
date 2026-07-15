# Rollout: 2026-07-15 Secure FMP Stable Endpoint Integration

## Summary
Integrated all Financial Modeling Prep (FMP) APIs using safe, key-scrubbing fetch routing and transitioned all endpoints to the new stable `/stable/` base path.

## Why
1. Legacy `/api/v3/` and `/api/v4/` endpoints are now restricted (returns 403 Legacy Endpoint on newer credentials).
2. Direct raw fetch calls in legacy modules logged full request URLs on error, representing a query-param API key leak hazard.

## Files Touched
- `src/lib/fmp-common.ts` [NEW]
- `src/lib/fmp-alpha.ts` [NEW/OVERWRITTEN]
- `src/lib/fmp-beta.ts` [NEW]
- `src/lib/fmp-delta.ts` [NEW/OVERWRITTEN]
- `src/lib/fmp-gamma.ts` [MODIFY]
- `scripts/test-fmp-integration.ts` [NEW]

## Verification
1. **Type Safety check**: `npx tsc --noEmit` completed successfully with zero errors.
2. **Existing test suite**: `npm test test/fmp-transcripts.test.ts test/fmp-transcripts-telemetry.test.ts` passed 100% of 40 tests cleanly.
3. **Integration Verification**: Created and executed `scripts/test-fmp-integration.ts` using `npx tsx scripts/test-fmp-integration.ts`.
   - Verified active economic indicators, treasury rates, congress trades, news, calendars, DCF, financial scores, and analyst ratings return correct data.
   - Verified that premium-only endpoints (quotes, ETF holdings, call transcripts) degraded gracefully returning `null` or empty arrays with descriptive warning logs, preventing crashes.
