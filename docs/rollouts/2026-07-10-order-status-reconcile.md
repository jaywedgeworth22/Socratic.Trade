# 2026-07-10 — Order-status reconciliation: kill the perpetual "verify with broker" alert

Branch: `claude/order-status-reconcile` (order-status-reconcile workflow, CLAUDE)

## Summary

Placement errors no longer leave an order "always uncertain." When a broker
`placeEquityOrder` call THROWS, both placement paths now ask the broker what
actually happened — via the existing `refId → client_order_id/ref_id`
idempotency key — and map the result to a DEFINITE proposal status instead of
immediately firing a permanent, un-clearable "verify with broker" alert.

## Why

Confirmed root cause (three gaps, all verified in code):

1. **No inline reconciliation.** Both catch blocks — autonomous run loop
   (`strategy.ts`) and human-approval path (`executeProposal`) — on a thrown
   `placeError` set status `placing_failed`, fired a permanent
   `run_failed` "…placement uncertain — verify with broker" notification, and
   moved on. Neither queried the broker.
2. **The alert was un-clearable and never resolved on recovery.**
   `isBrokerVerificationRunFailed` marked any such row non-sweepable, and nothing
   acked it when the order later reconciled (sweep recovery or a normal fill). A
   fully placed-and-filled order left a permanent alert.
3. **The catch set `placing_failed`, but the stale sweep filters
   `status = 'placing'`** (`listStalePlacingProposals`). So an inline-thrown row
   was never reconciled by the sweep at all — the transient-throw case had *no*
   reconciliation path, which is exactly why the alert was perpetual.

The old comments claiming the `client_order_id` plumbing was "a follow-up / we
can't yet auto-match" were stale — the plumbing already exists
(`EquityOrder.clientOrderId`, populated by both broker adapters) and the sweep
already used it. Comments corrected.

## What changed

- **New shared helper `reconcilePlacementError(...)`** (`src/lib/strategy.ts`,
  exported) called from both placement catches. Broker-truth-first, mirroring the
  sweep's matching:
  - `getEquityOrders` throws → `uncertain` (broker unreachable — the ONLY
    genuinely-unknown case).
  - no order carries our `refId` → `not_placed` (order never reached the matching
    engine; safe to retry).
  - order present + terminal-declined (`isRejectedOrCanceledState`) → `declined`.
  - order present + live/filled → `placed` (books the fill here, deduped on
    `(proposalId, brokerOrderId)`; a booking error degrades to `uncertain` so the
    intent + alert are never dropped).
- **Caller mapping** in both catches maps each outcome to a definite status +
  a distinctly-toned notification carrying a `payload.reconcile` discriminator
  (`recovered` / `declined` / `not_placed` / `uncertain`):
  - placed → status `placed`, `type:"fill"` (recovered) notification, prior
    uncertain alert resolved, dashboard event.
  - declined → status `rejected_by_broker`, decline notification.
  - not_placed → **new status `not_placed`**, sweepable "was NOT placed — safe to
    retry" notification.
  - uncertain → status kept **`placing`** (not `placing_failed`) so
    `flagStalePlacingIntents` retries next run; protected "verify with broker"
    alert. This is now the ONLY path that produces a perpetual-until-confirmed
    alert, and only when the broker is truly unreachable.
- **New status `not_placed`** added to `FEED_STATUS_LABELS` ("Not placed - safe to
  retry") in `src/lib/dashboard-ui.ts`. `status` is free-form (`string`); no
  exhaustive switch consumes it.
- **`resolveBrokerVerificationNotifications(userId, {proposalId?, refId?,
  resolution})`** (`src/lib/db-notifications.ts`, re-exported via the `db` barrel):
  surgically acks the uncertain alert for a now-confirmed proposal/order (matched
  by the exact UUIDs; only `reconcile:"uncertain"` or legacy-title rows; never a
  `declined` row). Called from (a) both inline `placed` branches, (b) the sweep's
  recovery branch — the primary fix for "even reconciled orders stay uncertain",
  and (c) `reconcilePendingFills` when a live order reaches `filled`.
- **`isBrokerVerificationRunFailed` is now reconcile-marker-driven** (drops the
  blanket "has proposalId/orderId ⇒ protected" short-circuit that would wrongly
  protect the new sweepable `not_placed` alert). `uncertain`/`declined` stay
  protected; `not_placed`/`placed`/`recovered` are sweepable; legacy rows (no
  marker) fall back to the enumerated title text. Stale doc-comment line numbers
  fixed.
- **Idempotency (two layers).** Layer A: status gate — the sweep only reads
  `status='placing'`, and inline leaves `placing` only when it booked nothing.
  Layer B: `(proposalId, brokerOrderId)` dedupe guard added to BOTH the inline
  `placed` booking and the sweep's matched branch (the sweep previously booked
  unconditionally), covering the crash window where a fill was inserted but the
  status flip didn't persist.

## Files

- `src/lib/strategy.ts` — `reconcilePlacementError` helper (new, exported); both
  placement catches rewritten; `flagStalePlacingIntents` dedupe guard + recovery
  resolution + exported for tests; `reconcilePendingFills` filled-branch
  resolution; stale sweep doc-comment corrected; `FillEvent` +
  `listFillEventsByProposalId` + `resolveBrokerVerificationNotifications` imports.
- `src/lib/db-notifications.ts` — `resolveBrokerVerificationNotifications` (new);
  `isBrokerVerificationRunFailed` refined + doc-comment corrected; `audit` import.
- `src/lib/dashboard-ui.ts` — `not_placed` label.
- `test/placement-reconcile.test.ts` (new, 5 e2e via `executeProposal`).
- `test/placement-reconcile-sweep.test.ts` (new, 4 — sweep idempotency +
  resolution).
- `test/notification-lifecycle.test.ts` (+5 — resolution + reconcile-marker
  sweepability, incl. legacy back-compat).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

Run in the worktree (node_modules built for node26/ABI 147, so gates ran under
the default `node v26.5.0`; `npx tsc --noEmit` also run under node@24):

- `npx tsc --noEmit` — clean (0 errors).
- `npm test` — **3408/3408 passed** (317 files).
- `npm run lint` — 0 errors (376 grandfathered warnings).
- `npm run build` — success (exit 0, full route manifest).

## Money-path invariants

- No change to Alpaca/Robinhood placement or the idempotency keys (they work).
- A fill for a given `proposalId` is booked by exactly one of {inline, sweep}
  (status gate + dedupe guard).
- Status `placed` / a booked fill is produced ONLY when a broker order whose
  `clientOrderId === refId` exists and is not terminal-declined. Missing ⇒
  `not_placed`; declined ⇒ `rejected_by_broker`; never a phantom "placed".
- The durable `placing` intent + protected uncertain alert are emitted ONLY when
  `getEquityOrders` throws (broker truly unreachable).
- Resolution is surgical (exact UUID match, uncertain-marked only) and
  account/user-scoped.

## Follow-ups / risks

- Robinhood MCP occasionally returns orders without `ref_id`; a genuinely-placed
  order lacking `clientOrderId` would be classed `not_placed` (false "safe to
  retry"). This is the SAME limitation the existing sweep already had — not a
  regression. A secondary fuzzy key `(symbol, side, qty, createdAt≈)` was
  deliberately NOT added: a false-positive match would book a phantom fill
  (violates MP-2). Left as a future follow-up.
- HEADS-UP: `claude/tradier-broker` also touches `strategy.ts` (broker-union
  switch cases — a different region than the placement catches here). If a
  merge-forward conflicts, keep both sets of changes.
