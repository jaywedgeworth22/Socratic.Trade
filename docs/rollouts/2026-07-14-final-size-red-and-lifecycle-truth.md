# Final-size Red review and lifecycle truth

Date: 2026-07-14
Owner: CODEX
Branch: `codex/account-relative-risk-review-fixes`
Landing base: `origin/main@86971ec4` (integrated)

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

git diff --check
# passed before the latest hostile-review remediations; rerun in the final gate
```

The full test/build gate will be appended after current-main reconciliation.

## Follow-ups

- Merge current `origin/main` (including PR #1578's TypeScript-toolchain repair), then run lint,
  TypeScript, all Vitest tests, and the production build in the required order.
- Land through `scripts/land.sh`, open a ready PR, auto-merge after hosted verification, resolve the
  original PR #1561 review threads, and verify the exact production SHA plus DB/scheduler/Litestream
  health.
- No broker-protective-stop file, host configuration, production secret, or corpus state is changed
  by this effort.
