# 2026-07-08 — Centralized Congress API client factory (AG)

## Summary
Refactored the Congress Trade API interactions by replacing the standalone `congress-trade-client.ts` with a centralized factory at `src/lib/api-clients/congress.ts` to ensure consistent health logging and gating.

## Why
The application was calling the Congress Trade API via direct `fetch` calls and a dedicated module that lacked consistent health monitoring and redundant flag checking. By migrating to a unified factory (`getCongressTradeClient`), all interactions now pass through standard health logging (`CongressAPI`) and we ensure that analytics features don't inadvertently fetch when `CONGRESS_TRADE_ANALYTICS_ENABLED` is false.

## Files Touched
- `src/lib/api-clients/congress.ts` (NEW)
- `src/lib/congress-trade-client.ts` (DELETED)
- `src/lib/history.ts`
- `src/lib/data-providers.ts`
- `src/lib/web-sources/congress-analytics.ts`
- `src/lib/web-sources/congress.ts`
- `test/congress-trade-client.test.ts` (DELETED)
- `test/api-clients-congress.test.ts` (NEW)

## Verification
- `npm run lint` — ran as part of CI gate
- `npx tsc --noEmit` — passes with no errors
- `npm test` — passed all 2970 tests
- `npm run build` — completed successfully

## Follow-ups
None at this time.
