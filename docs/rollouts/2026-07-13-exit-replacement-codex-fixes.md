# Rollout Note: Exit Replacement Codex Review Fixes

## Summary
Resolved the three Codex review findings on the Exit Replacement State Machine (`PR #1492`). Added unit tests and verified the system via the full compilation, lint, test, and build pipeline.

## Why / Decisions Made
- **Auto Mode Off Continuation (P2)**: When a user sets `autoRemediateStaleExits === false`, it should only prevent the creation of *new* auto-remediation records. Any existing/manual cancel-replacement state machines already in progress (e.g. `cancel_requested` or `cancel_confirmed`) must continue to be pumped to completion to prevent orders from being stranded.
- **Order Details Column Persistence (P1)**: Re-fetching the original order by ID from `getEquityOrders` can fail on later ticks if the broker removes terminal/canceled orders from active order lists (e.g., Robinhood). Adding a database migration (`version 19`) to add original order details (`symbol`, `side`, `original_type`, `original_quantity`, and `original_filled_quantity`) ensures the state machine can reconstruct a minimal order object and place the market replacement successfully even if the order is no longer returned by the broker.
- **Reconciliation of `replacement_submitted` (P1)**: If the coordinator or server crashes after marking a row as `replacement_submitted` but before it receives and records the confirmation, the row would get stuck and no-op on subsequent ticks. Implemented a reconciliation step that searches `getEquityOrders` by `clientOrderId` (matching `replacement_ref_id`) to confirm placement, inserts missing `fill_events`, verifies webhook-created fill events, and times out/fails rows stuck for > 5 minutes.

## Touched Files
- [src/lib/db.ts](file:///Users/jay/apps/trading-ag-safety/src/lib/db.ts) (Added migration 19 and updated `order_replacements` creation statement)
- [src/lib/order-replacement.ts](file:///Users/jay/apps/trading-ag-safety/src/lib/order-replacement.ts) (Updated autoRemediateStaleExitOrders, stepReplacementState, and OrderReplacementRow type)
- [test/order-replacement.test.ts](file:///Users/jay/apps/trading-ag-safety/test/order-replacement.test.ts) (Added reconstruction and reconciliation recovery unit tests)
- [STATUS.md](file:///Users/jay/apps/trading-ag-safety/STATUS.md) (Updated status)

## Verification
Executed all four required verification steps:
1. Type check: `npx tsc --noEmit` -> Clean, 0 errors
2. Lint check: `npm run lint` -> Clean, 0 errors, 437 warnings
3. Test suite: `npm test` -> 3929 tests passed (including new tests)
4. Production build: `npm run build` -> Clean compile and optimization
