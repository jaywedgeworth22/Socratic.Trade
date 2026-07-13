# Rollout Note: Exit Replacement Codex Review Fixes

## Summary
Resolved initial Codex review findings on the Exit Replacement State Machine (`PR #1492`), then addressed 5 additional P1 findings from the second Codex review. Added unit tests and verified the system via the full compilation, lint, test, and build pipeline.

## Why / Decisions Made
### Round 1 (2026-07-12)
- **Auto Mode Off Continuation (P2)**: When a user sets `autoRemediateStaleExits === false`, it should only prevent the creation of *new* auto-remediation records. Any existing/manual cancel-replacement state machines already in progress (e.g. `cancel_requested` or `cancel_confirmed`) must continue to be pumped to completion to prevent orders from being stranded.
- **Order Details Column Persistence (P1)**: Re-fetching the original order by ID from `getEquityOrders` can fail on later ticks if the broker removes terminal/canceled orders from active order lists (e.g., Robinhood). Adding a database migration (`version 19`) to add original order details (`symbol`, `side`, `original_type`, `original_quantity`, and `original_filled_quantity`) ensures the state machine can reconstruct a minimal order object and place the market replacement successfully even if the order is no longer returned by the broker.
- **Reconciliation of `replacement_submitted` (P1)**: If the coordinator or server crashes after marking a row as `replacement_submitted` but before it receives and records the confirmation, the row would get stuck and no-op on subsequent ticks. Implemented a reconciliation step that searches `getEquityOrders` by `clientOrderId` (matching `replacement_ref_id`) to confirm placement, inserts missing `fill_events`, verifies webhook-created fill events, and times out/fails rows stuck for > 5 minutes.

### Round 2 (2026-07-13)
- **Keep ambiguous submissions pending (P1)**: When `placeEquityOrder` throws (timeout or dropped connection), the row was immediately marked `failed`. Since the broker may have accepted the order before the connection dropped, this loses the replacement state. Now the row stays in `replacement_submitted` and the reconciliation branch looks up the broker order by `replacement_ref_id` on the next tick. Only explicit broker rejections (detected via `isRejectedOrCanceledState` on the returned execution) directly fail the row.
- **Terminal broker states (P1)**: The `replacement_submitted` reconciliation branch confirmed the replacement unconditionally when the broker order was found. If the broker's order had state `rejected` or `canceled`, the replacement was incorrectly marked as confirmed without an actual exit order. Added `isRejectedOrCanceledState(found.state)` check before confirming.
- **Cancel-confirmed rows retriable (P1)**: Transient errors (network, broker timeout) in the `cancel_confirmed` branch permanently failed the row, even though the original limit order was already canceled. The pump would stop retrying, leaving the exit canceled without replacement. Now `cancel_confirmed` rows stay in their state on transient errors, and the pump retries the market replacement on the next tick.
- **Cancel-requested conditional failure (P1)**: When two scheduler instances both process the same `cancel_requested` row, one's `cancelEquityOrder` call succeeds and the other's returns "already canceled." The failing worker's catch block previously unconditionally marked the row `failed`, overwriting the successful peer's transition to `cancel_confirmed`. Now the failure update uses `WHERE status = 'cancel_requested'`, so it only affects the row if it hasn't been advanced by another instance.
- **Migration v20 for indexes (P1)**: The `idx_order_replacements_active_unique` and `idx_order_replacements_user_account_status` indexes were originally added inside migration v6, but deployed databases already have `PRAGMA user_version` past 6, so `runMigrations` skipped the block. Added a new migration v20 that creates these indexes unconditionally (`CREATE INDEX IF NOT EXISTS`) so existing databases get the concurrency guard.

## Touched Files
- [src/lib/db.ts](file:///Users/jay/apps/trading-ag-safety/src/lib/db.ts) (Added migration 19 and 20, updated `order_replacements` creation statement)
- [src/lib/order-replacement.ts](file:///Users/jay/apps/trading-ag-safety/src/lib/order-replacement.ts) (Updated autoRemediateStaleExitOrders, stepReplacementState, catch blocks, and OrderReplacementRow type)
- [test/order-replacement.test.ts](file:///Users/jay/apps/trading-ag-safety/test/order-replacement.test.ts) (Added reconstruction and reconciliation recovery unit tests)
- [STATUS.md](file:///Users/jay/apps/trading-ag-safety/STATUS.md) (Updated status)

## Verification
Executed all four required verification steps:
1. Type check: `npx tsc --noEmit` -> Clean, 0 errors
2. Lint check: `npm run lint` -> Clean, 0 errors, 439 warnings
3. Test suite: `npm test` -> 350 suites / 3930 tests passed
4. Production build: `npm run build` -> Clean compile and optimization

### Round 3 (2026-07-13)
Addressed 4 additional Codex findings (2 P1, 2 P2) and asked about 1 (P2):
- **Record fill before terminal confirmation (P1)**: Moved the `replacement_confirmed` status update after `insertFillEvent` so a crash or fill-insert failure doesn't leave a terminal row with no fill event — no fill means the pump never re-selects the row and Activity/P&L permanently misses the replacement.
- **Guard submitted-row failure updates with active status (P1)**: Both the timeout path (age > 5 min in `replacement_submitted`) and the catch block's default case now filter `WHERE status = 'replacement_submitted'` to prevent a stale or erroneous failure from overwriting a peer's successful reconciliation. Also applied to the catch block's default case.
- **Avoid booking recovered fills at zero price (P2)**: When `averagePrice` is null on a filled broker order during recovery, the fill is kept as `pending_reconciliation` instead of being booked at price 0 with status `filled`. Normal pending-fill reconciliation will fill in the price later.
- **Purge replacements when deleting a connected account (P2)**: Added `"order_replacements"` to the `purgeConnectedAccount` transactional cleanup loop to prevent orphaned replacement rows when a connected account is removed.
- **Congress share in-flight work keying (P2 — asked maintainer)**: `activeDailySharePromise` does not differentiate by `options` (symbols, force, etc.). An admin backfill during the nightly run would silently return the nightly run's result. Too architecturally significant to guess — posted a comment asking the maintainer which approach to take.

### Files changed (Round 3)
- `src/lib/order-replacement.ts` — Fill-ordering fix, status-guarded failure paths, null-averagePrice fill marking
- `src/lib/db-api-keys.ts` — Added `order_replacements` to purge table list

Verification: all four gates pass at each round boundary.
