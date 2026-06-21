# 2026-06-21 — refactor(db): split db.ts into 8 focused modules

## Summary

Split the monolithic `src/lib/db.ts` (2330 lines) into 8 logical sub-modules using a
barrel re-export pattern. All existing `import { X } from "src/lib/db"` call sites continue
to work without any changes.

## Why

`db.ts` had grown to 2330 lines across 9 functional areas. It was hard to navigate,
slow to review in diffs, and made it easy to accidentally create cross-domain dependencies.
The split was purely mechanical — no function signatures or behaviors changed.

## Module breakdown

| New file | Contents |
|---|---|
| `src/lib/db-settings.ts` | getUserSetting, setUserSetting, getSetting, setSetting, getInternalSetting, setInternalSetting, deleteInternalSetting, DataPoolConsent, recordMarketDataDemand, fulfillMarketDataDemand, clearMarketDataDemandsForTests |
| `src/lib/db-learning.ts` | listAudit, latestAuditByKind, counterfactual learning watermarks, skipped counterfactual candidates |
| `src/lib/db-profiles.ts` | listStrategyProfiles, getActiveStrategyProfile, createStrategyProfile, getStrategyProfile, updateStrategyProfile, activateStrategyProfile |
| `src/lib/db-execution.ts` | DAILY_RESET_TIME_ZONE, startOfDayInTimeZone, dailyExecutionStats, notionalInLastMinutes, countDayTradesInLastBusinessDays, acquireStrategyLock, releaseStrategyLock, insertStrategyRun, finishStrategyRun, listStrategyRuns |
| `src/lib/db-proposals.ts` | listPendingProposals, markProposalRevalidated, getProposal, updateProposalStatus, claimProposalForExecution, listStalePlacingProposals, findProposedIdByRunId, insertProposal |
| `src/lib/db-fills.ts` | insertPortfolioSnapshot, listPortfolioSnapshots, insertFillEvent, listFillEvents, updateFillEvent, upsertFillExcursions, upsertFillExcursionsByKey |
| `src/lib/db-notifications.ts` | insertNotificationEvent, listNotificationEvents |
| `src/lib/db-api-keys.ts` | encryption helpers, UserApiKey, API key CRUD, ConnectedAccount CRUD, SyntheticTrailingStop CRUD, listUsers, watchlist, price alerts, notify prefs, chat turns, memory |

`db.ts` retained: `getDb()`, schema migration, `getPolicy`/`setPolicy`/`getStrategyPrompt`/`setStrategyPrompt`, `audit()`, `mergePolicy`, `normalizeScoringWeights`, `syncActiveProfile`, `setSettingDirect`, `scopeAccount`, and all barrel re-exports.

## Files touched

- `src/lib/db.ts` (modified — reduced from ~2330 to ~500 lines)
- `src/lib/db-settings.ts` (new)
- `src/lib/db-learning.ts` (new)
- `src/lib/db-profiles.ts` (new)
- `src/lib/db-execution.ts` (new)
- `src/lib/db-proposals.ts` (new)
- `src/lib/db-fills.ts` (new)
- `src/lib/db-notifications.ts` (new)
- `src/lib/db-api-keys.ts` (new)
- `STATUS.md` (updated)
- `docs/rollouts/2026-06-21-db-module-split.md` (this file)

## Verification

```
npx tsc --noEmit   # clean
npm test           # 607 tests, 72 files, all pass
npm run build      # Next.js build clean
```

## Design notes

- Barrel pattern: `db.ts` re-exports all sub-modules via `export * from "./db-X"` so every
  existing import remains valid.
- Shared helpers (`audit`, `mergePolicy`, `normalizeScoringWeights`, `syncActiveProfile`,
  `setSettingDirect`, `scopeAccount`) stay in `db.ts` and are imported by sub-modules.
- Circular import db.ts ↔ db-profiles.ts (db-profiles calls `getPolicy`/`getStrategyPrompt`
  from db.ts; db.ts imports `getActiveStrategyProfile` from db-profiles.ts) is safe because
  all circular references are inside function bodies (lazy resolution at call time).
- Similar safe circular: db.ts imports `getActiveConnectedAccount` from db-api-keys.ts to
  use in `getPolicy`; db-api-keys.ts imports `audit` and `getDb` from db.ts.

## Follow-ups

- None required. This is a pure refactor with no behavior changes.
