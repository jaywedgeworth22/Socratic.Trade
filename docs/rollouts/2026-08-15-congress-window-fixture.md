# 2026-08-15 — Congress overlay test fixture fell out of the 60-day window

## Context & Objective

`verify-hosted` failed on leftover audit PRs (#2691, #2719) with the same assertion: `overlay.NVDA?.congress?.buyCount` was `undefined`.  Neither PR touches web-sources.  The live-flow mock used hardcoded `06/16/2026` filings; `DEFAULT_WINDOW_DAYS` is 60, and 2026-08-15 is day 60 after that filing date, so `aggregateCongressSignals` dropped the trade (`Date.parse("2026-06-16")` is just before `now - 60d`).

## Changes Made

- `test/web-sources.test.ts`: `stubEfdSuccess` now builds filing/trade dates from `Date.now()` (10d / 14d ago) so the overlay stays inside the window.

## Decisions & Trade-offs

- Test-only.  No production congress window change.
- Dedicated branch so leftover FTS / r4 / r5 PRs can rematch a green main, and so other open PRs stop failing the same way.

## Verification State

```bash
npx vitest run test/web-sources.test.ts
```

16 passed / 16.

## Next Steps & Blockers

Rematch #2689 / #2691 / #2719 after this lands (or cherry-pick the test file onto those branches).  Do not flip `SEC_INGEST_WORKER_ENABLED`.
