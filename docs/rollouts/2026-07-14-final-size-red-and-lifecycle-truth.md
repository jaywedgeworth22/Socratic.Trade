# Final-size Red review and lifecycle truth

Date: 2026-07-14
Owner: CODEX
Branch: `codex/account-relative-risk-review-fixes`
Landing base: `origin/main@f331b28a` (integrated)

## Summary

- Removed the obsolete large-dollar sentinel conversion, so an explicitly configured `$500,000`
  or larger daily cap remains a dollar cap. Migration regressions cover settings, user settings,
  account strategy state, and strategy profiles, including intentional post-v26 `$500` values.
- Added one shared final-sizing receipt and one-shot Red rerun after a successful broker-minimum
  bump. The autonomous and approval paths now agree on exact route, notional, NAV percentage,
  daily-cap arithmetic, Red result, half-size behavior, and owner-override state.
- Kept independent human-review reasons separate; final-size Red approval cannot clear a
  rationale-collapse or unresolved owner-preference hold.
- Synchronized proposal lifecycle changes into Socratic decisions transactionally. Autonomous
  placement now commits the initial proposal intent and Socratic case together before calling the
  broker; uncertain submissions remain `placing` rather than appearing safe to retry.
- Required a proposed Socratic intent receipt inside the approval claim transaction. Legacy rows
  receive a fallback case in that same transaction; a receipt write failure stops before the broker.
- Made chat-draft promotion idempotent across the proposal's whole lifecycle, not only while it is
  `proposed`. A second lookup under the same immediate write transaction as insertion closes the
  concurrent stage/approve race; retries return the original row and its current status.
- Made stale broker-fill recovery treat a matching receipt as a reconciliation target rather than
  only as an insert dedupe key. A pending receipt that the broker now reports filled is finalized in
  the same transaction as proposal and Socratic lifecycle truth.
- Treated terminal broker states with positive `filledQuantity` as real final partial executions
  across approval, autonomous placement, inline error recovery, delayed reconciliation, stale
  intent recovery, and stale-limit replacement. Zero-fill terminal states remain declines.
- Required a finite positive realized broker price before any execution becomes `filled` or
  `partially_filled`. Until then, broker receipts store `price=0` / `notional=0` rather than a
  proposal, quote, or review estimate, and remain eligible for reconciliation.
- Made cumulative broker execution monotonic even while price is unresolved. Each receipt retains
  the maximum quantity actually reported by the broker in raw evidence; a smaller or terminal-zero
  snapshot cannot erase it, and a priced snapshot must cover that floor before accounting advances.
- Committed direct broker fill receipt plus proposal/Socratic lifecycle atomically. If the local
  receipt fails, status remains `placing` under the durable refId so the stale sweep can recover;
  nonterminal responses without an order id follow the same recovery route.
- Counted working `partially_filled` receipts as current exposure/P&L while updating the same receipt
  in place as quantity advances. Replacement dedupe now requires user, account, and replacement
  identity, preventing a reused broker order id in another scope from suppressing a real fill.
- Replaced the legacy account-global active-replacement unique index with a
  `(user_id, account_number, original_order_id)` partial index in migration v28. Replacement
  partials lacking price or broker order id stay on the durable refId recovery rail, update the same
  receipt once broker truth arrives, and never retry the dead remainder of a terminal partial.
- Bound missing legacy chat-case repair to the proposal's historical account and account-scoped
  authority rather than whichever account happens to be selected on retry. Repair runs before
  current-account gates and recreates terminal lifecycle status/notional as well as proposed cases.
- Kept synchronous fills as `filled` throughout cap accounting, run/ops counts, approval success,
  Activity detail, case lifecycle, and outcome-coverage denominators.
- Serialized vector-memory updates per decision and re-read the current durable case before each
  write, so a slow older embed cannot overwrite a newer terminal state.
- Kept Green, deterministic sizing, Red, and outcome evidence visually and semantically separate.
  Approval cards now use structured Green-only text; user-facing status distinguishes Red advice,
  owner override, broker rejection, and pending confirmation.
- Added a direct GPT-5.6 Terra Responses/effort regression and catalog invariants proving the
  curated OpenAI pickers retain Nano/Mini plus Luna/Terra/Sol while excluding full GPT-5.4/5.5.

## Why

The broker can apply a minimum-size adjustment after the first Red review. Persisting or displaying
that larger order with a pre-bump sizing receipt and verdict makes the evidence internally false.
Likewise, proposal and Socratic ledgers that transition independently can tell the user a completed
or uncertain placement is still merely proposed—or safe to retry. These changes make the exact
broker-submitted shape and the durable lifecycle one invariant across strategy, approval, memory,
and UI without turning owner-configured preferences into immutable gates.

## Files

- `app/console/components/approval-card.tsx`
- `app/console/approvals/page.tsx`
- `app/console/lib/labels.ts`
- `app/console/lib/red-team.ts`
- `app/console/lib/thesis.ts`
- `app/console/page.tsx`
- `src/lib/chat/llm.ts`
- `src/lib/db-profiles.ts`
- `src/lib/db-execution.ts`
- `src/lib/db-proposals.ts`
- `src/lib/broker-side.ts`
- `src/lib/order-replacement.ts`
- `src/lib/performance.ts`
- `src/lib/db-socratic.ts`
- `src/lib/db.ts`
- `src/lib/finalized-sizing-review.ts`
- `src/lib/dashboard-feed.ts`
- `src/lib/dashboard-ui.ts`
- `src/lib/ops-snapshot.ts`
- `src/lib/rag/multi-query.ts`
- `src/lib/socratic-memory.ts`
- `src/lib/socratic-runtime.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/strategy.ts`
- `src/lib/types.ts`
- `test/broker-minimum-bump-execute.test.ts`
- `test/console-red-team-labels.test.ts`
- `test/final-size-red-autonomous.test.ts`
- `test/finalized-sizing-review.test.ts`
- `test/llm-call.test.ts`
- `test/openai-model-catalog.test.ts`
- `test/persistence-hardening.test.ts`
- `test/chat-draft-policy.test.ts`
- `test/dashboard-feed.test.ts`
- `test/deep-safety-fixes.test.ts`
- `test/execution-mode-persistence.test.ts`
- `test/ops-snapshot.test.ts`
- `test/outcome-engine.test.ts`
- `test/placement-reconcile.test.ts`
- `test/placement-reconcile-sweep.test.ts`
- `test/reconciliation-risk.test.ts`
- `test/order-replacement.test.ts`
- `test/performance.test.ts`
- `test/broker-side.test.ts`
- `test/e2e-money-path.test.ts`
- `test/redteam-failure-routing.test.ts`
- `test/strategy-money-path-f-g.test.ts`
- `test/socratic-db.test.ts`
- `test/socratic-memory.test.ts`
- `test/strategy-bear-fail-closed.test.ts`
- `docs/settings-navigation-redesign/spec/04-settings-field-reference.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-07-13-account-relative-risk-postmerge-review.md`
- `docs/rollouts/2026-07-14-final-size-red-and-lifecycle-truth.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

Using Node `v24.18.0`:

```bash
npm run lint
# passed: 0 errors / 458 inherited warnings

npx tsc --noEmit
# passed

npx vitest run test/final-size-red-autonomous.test.ts test/socratic-db.test.ts \
  test/console-red-team-labels.test.ts test/broker-minimum-bump-execute.test.ts \
  test/finalized-sizing-review.test.ts test/persistence-hardening.test.ts
# passed: 6 files / 53 tests

npx tsc --noEmit
# passed after merging origin/main@86971ec4

npx vitest run test/final-size-red-autonomous.test.ts test/socratic-db.test.ts \
  test/console-red-team-labels.test.ts test/broker-minimum-bump-execute.test.ts \
  test/finalized-sizing-review.test.ts test/persistence-hardening.test.ts \
  test/console-action-rows.test.ts test/placement-reconcile.test.ts
# passed after merge: 8 files / 68 tests

npx tsc --noEmit
# passed after the final hostile-review remediations

npx vitest run test/placement-reconcile.test.ts test/final-size-red-autonomous.test.ts \
  test/socratic-db.test.ts test/chat-draft-policy.test.ts test/deep-safety-fixes.test.ts \
  test/execution-mode-persistence.test.ts test/console-red-team-labels.test.ts \
  test/dashboard-feed.test.ts test/broker-minimum-bump-execute.test.ts \
  test/approval-lock.test.ts test/order-confirmation-status.test.ts \
  test/protective-exit-reprice.test.ts test/strategy-lock-loss-integration.test.ts \
  test/ops-snapshot.test.ts test/outcome-engine.test.ts
# passed: 15 files / 132 tests

npx tsc --noEmit
# passed after current main and the final chat/stale-receipt race remediations

npx vitest run test/chat-draft-policy.test.ts test/placement-reconcile-sweep.test.ts \
  test/deep-safety-fixes.test.ts test/reconciliation-risk.test.ts \
  test/placement-reconcile.test.ts test/socratic-db.test.ts test/e2e-money-path.test.ts \
  test/redteam-failure-routing.test.ts test/strategy-money-path-f-g.test.ts
# passed: 9 files / 92 tests

npx tsc --noEmit
# passed after terminal-partial, atomic direct-receipt, replacement-scope, and historical-account fixes

npx vitest run test/order-replacement.test.ts test/broker-side.test.ts \
  test/placement-reconcile.test.ts test/placement-reconcile-sweep.test.ts \
  test/reconciliation-risk.test.ts test/performance.test.ts \
  test/chat-draft-policy.test.ts test/strategy-money-path-f-g.test.ts
# passed: 8 files / 151 tests

npx vitest run test/placement-reconcile.test.ts test/order-replacement.test.ts
# passed after the missing-order-id recovery guard: 2 files / 31 tests

npx tsc --noEmit
# passed after finite-price, monotonic-quantity, replacement-ref, and terminal chat-case fixes

npx vitest run test/broker-side.test.ts test/reconciliation-risk.test.ts \
  test/placement-reconcile.test.ts test/placement-reconcile-sweep.test.ts \
  test/strategy-money-path-f-g.test.ts test/order-replacement.test.ts \
  test/chat-draft-policy.test.ts test/performance.test.ts
# passed: 8 files / 167 tests

# Final independent re-review: no P0-P2 findings.

git diff --check
# passed after the latest hostile-review remediations

# Diagnostic full-suite pass after broad-fixture and migration-v28 remediation
npm test
# passed: 368 files / 4,124 tests

# Final authoritative ordered Node 24 gate
npm run lint
# passed: 0 errors / 458 inherited warnings

npx tsc --noEmit
# passed

npm test
# passed: 368 files / 4,124 tests

npm run build
# passed: real TypeScript phase, 32 static pages

git diff --check
# passed
```

## Follow-ups

- Land through `scripts/land.sh`, open a ready PR, auto-merge after hosted verification, resolve the
  original PR #1561 review threads, and verify the exact production SHA plus DB/scheduler/Litestream
  health.
- No broker-protective-stop file, host configuration, production secret, or corpus state is changed
  by this effort.
