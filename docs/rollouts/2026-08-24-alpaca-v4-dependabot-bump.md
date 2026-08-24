# 2026-08-24 — Alpaca-Trade-API v4 Migration & Compatibility Fix

## 1. Context & Objective
Dependabot PR #3077 updated `@alpacahq/alpaca-trade-api` from 3.1.3 to 4.0.1.  The v4 major release changed the library packaging structure and export shapes.  The objective was to ensure complete runtime and build compatibility with the v4 SDK across Next.js webpack bundling, Node 24/26 runtime, and test execution without breaking real-money trading execution paths or bracket order placements.

## 2. Changes Made
- **Universal Module Interop Adapter**: Updated `src/lib/alpaca.ts` to implement a robust, universal instantiation adapter that handles both ESM namespace default imports (`import * as AlpacaSDKModule from '@alpacahq/alpaca-trade-api'`), named exports, and CJS default fallbacks (`(AlpacaSDKModule as any).default || AlpacaSDKModule`).
- **Synchronized with Latest Main**: Re-merged `origin/main` to integrate `@jaywedgeworth22/congress-trading-shared@v2.6.0`, the updated lockfile, and SQLite migration safety guards (`tableExists` / `columnExists`).
- **Resolved Package Pinning Gate**: Re-generated `package-lock.json` ensuring identical provenance across `Socratic.Trade`, `Usage-Monitor`, and `Congress.Trade`.

### Touched Files
- `src/lib/alpaca.ts`
- `package.json`
- `package-lock.json`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `docs/rollouts/2026-08-24-alpaca-v4-dependabot-bump.md`

## 3. Decisions & Trade-offs
- **Universal Module Interoperability**: Rather than rewriting all wire parsers or risking subtle broker execution differences during market hours, the universal interop wrapper dynamically resolves the underlying SDK constructor while preserving full backward and forward compatibility for all bracket orders, streaming events, position mapping, and quote feeds.
- **Merge Origin/Main**: Brought in all recent main commits including CTS v2.6.0 pin to satisfy the mandatory `check-pin` CI gate.

## 4. Verification State
All five required verification commands executed locally and succeeded:
1. `npm run lint` -> Passed (0 errors).
2. `npx tsc --noEmit` -> Passed cleanly (0 type errors).
3. `npm test` -> 7,581 tests passed, 51 skipped across 682 test files.
4. `npm run build` -> Next.js 16.3.1 webpack build succeeded with all static/dynamic routes compiled.
5. `node scripts/check-shared-package-pin.mjs` -> Passed (`OK: ST/UM/CT share @jaywedgeworth22/congress-trading-shared@2.6.0`).

## 5. Next Steps & Blockers
- Commit the merge and updated docs.
- Push to branch `dependabot/npm_and_yarn/alpacahq/alpaca-trade-api-4.0.1`.
- Verify GitHub Actions PR checks on PR #3077 turn green.
- Merge PR #3077 to `main`.
