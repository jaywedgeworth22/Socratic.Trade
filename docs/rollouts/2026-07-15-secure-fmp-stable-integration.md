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
2. **Integration Verification**: Created and executed `scripts/test-fmp-integration.ts` using `npx tsx scripts/test-fmp-integration.ts`.
   - Verified active economic indicators, treasury rates, congress trades, news, calendars, DCF, financial scores, and analyst ratings return correct data.
   - Verified that premium-only endpoints (quotes, ETF holdings, call transcripts) degraded gracefully returning `null` or empty arrays with descriptive warning logs, preventing crashes.
3. **Database-Scoped Vitest Failure Resolution**:
   - Identified that database-scoped test failures (such as in `better-sqlite3` native bindings) were caused by running tests under Node 26 (default environment), mismatching the compiled NODE_MODULE_VERSION 137 (compiled against Node 24).
   - Resolved the mismatch by enforcing/prepending Node 24 (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`).
   - Verified the entire 375 test files / 4,263 tests passed cleanly under Node 24.
4. **Landing Flow**:
   - Ran `scripts/land.sh` under Node 24, which successfully checked TypeScript, passed the full test suite (4,263 tests), completed the Next.js production build, pushed the branch `agent/ag-fmp-transcripts`, and confirmed PR #1611 is open.

