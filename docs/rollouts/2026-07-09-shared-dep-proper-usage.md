# 2026-07-09 — Shared-dep proper-usage cleanup (CURSOR)

## Summary
Tightened Socratic.Trade's use of `@jaywedgeworth22/congress-trading-shared` so remaining
local duplicates of the cross-app contract are gone.

## Why
An audit found the app was largely migrated, but still had a hardcoded event-type list,
a parallel outbound payload interface, and unused shared imports that suggested incomplete
adoption.

## Files
- `src/lib/congress-trade-events.ts` — `isCongressEventType` uses `CONGRESS_EVENT_TYPES` (+ `trade.new` alias)
- `src/lib/congress-share.ts` — `CongressSharePayload` derived from shared `SharePayload`
- `src/lib/congress-trade-client.ts` — removed unused `API_PATHS` / `MAX_REFS_BATCH` imports
- `docs/EFFORT-LOG.md` — reserved In Progress row
- `STATUS.md` — snapshot note

## Verification
- `npx tsc --noEmit` — clean
- `npx vitest run test/congress-trade-events.test.ts test/congress-share.test.ts test/congress-stream.test.ts test/congress-webhook-parity.test.ts` — 77 passed

## Follow-ups
- After shared `v1.4.2` tags (project + subscription telemetry fields), bump the pin when
  App B starts sending `project` attribution.
- Optional: validate App A rows with `CongressTransactionSchema` in `coerceCongressTrade`.
