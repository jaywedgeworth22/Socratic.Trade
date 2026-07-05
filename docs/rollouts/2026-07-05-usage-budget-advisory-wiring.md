# 2026-07-05 - usage-budget-advisory-wiring

## Summary

Wired the previously-dormant usage-budget Phase 2 building block
(`evaluateBudgetForRun` / `cheaperModel` in `src/lib/usage-budget.ts`, which had
zero production callers before this change) into `runStrategyOnce`, as
**advisory-first with an owner-controlled enforcement preference**, matching
the repo's binding guardrail philosophy (advisory receipts + owner-overridable
preferences, never hard blocks; nothing is hard except the account boundary).

Two independent layers:

1. **ADVISORY — always on when the API Usage Monitor is configured**,
   independent of any enforcement flag:
   - Every run now reads cached budget status once (`getBudgetStatusCached`)
     and stamps a `usage_budget_status` audit receipt containing the raw
     per-provider spend/status/budget, plus a **preview** of what enforcement
     *would* decide (`wouldSkip` / `wouldDowngrade` / `suggestedLlmModel` /
     `suggestedRedTeamLlmModel` / `reason`) via a new `previewBudgetDecision`
     helper — so the owner can see what turning enforcement on would have done,
     without needing it on.
   - When at least one provider is at `warning` or `exceeded`, a new
     `formatBudgetAdvisory(status)` helper produces a compact 1-2 line string
     that gets injected into the Bull `userContent` next to the existing
     `drawdownAdvisory` block — explicitly framed as data ("YOU decide..."),
     never a directive. Mirrors the existing `drawdownAdvisory` precedent
     exactly (Bull-only; the Bear's `bearUserContent` does not currently carry
     `drawdownAdvisory` either, so no Bear-side change was made for parity).
   - Best-effort: wrapped in try/catch, never blocks or fails a run.

2. **ENFORCEMENT — opt-in via the existing `USAGE_BUDGET_ENFORCE` flag**
   (default off), applied at the existing per-user/day LLM budget choke point
   in `runStrategyOnce` — i.e. *after* the drawdown breaker and volatility
   brake (risk-reducing exits always run), *before* any LLM call (revalidation,
   RAG retrieval, episodic memory, Bull/Bear proposal generation):
   - **Skip**: audits `usage_budget_enforced` (`action: "skip"`), calls the
     existing `notifyBudgetSkip` helper (was written, had no caller before
     this), and ends the run gracefully — `status: "completed"`, empty
     proposals, no LLM call ever made, no LLM budget reservation taken.
   - **Downgrade**: swaps `policy.llmModel` / `policy.redTeamLlmModel` on the
     run's **in-memory** `RunnablePolicy` object only (never the object
     `setPolicy` might persist elsewhere in the same run, e.g. on a drawdown
     breaker trip) and audits `usage_budget_enforced` (`action: "downgrade"`)
     with `before`/`after` model snapshots. The next run reads the owner's
     configured model again from the DB — the downgrade is strictly
     transient/per-run.
   - Fail-open on any evaluator error (`evaluateBudgetForRun` already never
     throws; the call site also wraps in try/catch for defense in depth).

### `debateProposal` gained an optional 5th parameter

`src/lib/red-team.ts`'s `debateProposal(proposal, quote, isBullish, userId)`
previously **always re-read `getPolicy(userId)` from the DB**, so a transient,
non-persisted model downgrade applied to the run's in-memory policy would
never reach the Bear (Red Team) review — it would keep using the owner's
persisted (undowngraded) `redTeamLlmModel`. Added an optional 5th
`policyOverride?: TradingPolicy` parameter: when provided, it's used instead of
re-reading the DB. `strategy.ts`'s only production call site now passes the
run's `policy` object explicitly. All existing 4-arg call sites (in
`test/red-team.test.ts` and `test/p0-safety-fixes.test.ts`) are unaffected —
confirmed by running those suites green.

### Internal refactor: `computeBudgetDecision`

`evaluateBudgetForRun`'s decision logic was extracted into a private
`computeBudgetDecision(policy, status)` so both `evaluateBudgetForRun` (gated
on `USAGE_BUDGET_ENFORCE`) and the new `previewBudgetDecision` (gated only on
the monitor being configured, used for the advisory preview) share one
implementation. `evaluateBudgetForRun`'s existing tested public contract
(signature, gating, fail-open behavior) is unchanged — all 8 of its existing
unit tests in `test/usage-budget.test.ts` pass unmodified.

## Why

The usage-budget Phase 2 building block was fully implemented and unit-tested
(per its own module header) but explicitly deferred from `runStrategyOnce`
wiring because a naive wiring would be dangerous: it could skip risk-reducing
work, persist a temporary downgrade permanently, or fail to reach the Bear
review. This change does the wiring the way the deferred note called for:
advisory receipts by default (never silently changes behavior), an
owner-controlled opt-in for actual enforcement, enforcement placed strictly
after risk-reducing breakers and strictly before any LLM call, the downgrade
scoped to an in-memory object only, and the override explicitly threaded into
`debateProposal`.

This also follows the repo's standing guardrail philosophy: no new guardrail
should be a hard cage — it should be a logged, owner-overridable preference.
`USAGE_BUDGET_ENFORCE` is exactly that pattern (already existed, default off);
this change makes the advisory signal always visible (so the owner has data
to decide whether to opt in) while keeping the actual behavior change fully
opt-in.

## Files

- `src/lib/usage-budget.ts` — module header + `evaluateBudgetForRun` docstring
  updated (Phase 2 no longer "deferred"); extracted `computeBudgetDecision`;
  added `previewBudgetDecision` and `formatBudgetAdvisory`.
- `src/lib/strategy.ts` — advisory computation + `usage_budget_status` audit
  near the existing Phase 1 `checkBudgetAndAlert` call site; enforcement block
  at the per-user/day LLM budget choke point (skip/downgrade); `budgetAdvisory`
  threaded through `proposeTrades`'s input and into the Bull `userContent`;
  `debateProposal` call site now passes `policy` explicitly.
- `src/lib/red-team.ts` — `debateProposal` gained an optional `policyOverride`
  parameter (backward compatible).
- `test/usage-budget.test.ts` — 4 new tests for `formatBudgetAdvisory`
  (undefined on null/ok-only status, exceeded/warning summaries, silent
  omission of ok/unconfigured providers).
- `test/usage-budget-strategy-integration.test.ts` (new) — 4 e2e tests via
  `runStrategyOnce` against a `TestBrokerGateway` paper account (modeled on
  `test/strategy-money-path-f-g.test.ts`): advisory-only with enforcement off
  (receipt + advisory line visible in the stubbed OpenAI request body, no model
  change), enforced downgrade (model swap + receipt), enforced skip (run ends
  before any OpenAI call, receipt + notification), and evaluator failure
  (budget-status fetch errors → fail-open, run proceeds untouched).
- `STATUS.md`, `docs/EFFORT-LOG.md` — dated status + effort-board updates (see
  below).
- `docs/usage-monitor-integration.md` — Phase 2 section updated from "DEFERRED"
  to describe the actual wiring (advisory vs. enforcement split, choke point,
  `debateProposal` override).

## Verification

```
npx tsc --noEmit
# clean

npx vitest run test/usage-budget.test.ts test/usage-budget-strategy-integration.test.ts \
  test/red-team.test.ts test/strategy-money-path-f-g.test.ts test/p0-safety-fixes.test.ts \
  test/llm-budget-enforcement.test.ts test/rag-run-budget.test.ts test/run-budget-and-live-guard.test.ts \
  test/run-strategy-offline.test.ts test/strategy-bear-fail-closed.test.ts test/strategy-bull-truncation.test.ts \
  test/strategy-episodic-injection.test.ts test/strategy-hardening.test.ts test/strategy-llm-failover.test.ts \
  test/strategy-moneypath-drawdown-flip.test.ts test/strategy-rag-quickwins-wiring.test.ts \
  test/strategy-rationale-collapse-gate.test.ts test/token-budget-ceiling.test.ts \
  test/strategy-copy-to-account.test.ts test/strategy-prompt-version.test.ts \
  test/strategy-review-display.test.ts test/strategy-tuning-missed-opps.test.ts test/strategy-tuning.test.ts
# 23 test files, 175 tests, all passed

npx eslint src/lib/usage-budget.ts src/lib/strategy.ts src/lib/red-team.ts \
  test/usage-budget.test.ts test/usage-budget-strategy-integration.test.ts
# 0 errors, 8 pre-existing grandfathered warnings (no-unused-vars / no-explicit-any) unrelated to this change
```

Per this lane's instructions, full `npm test` and `npm run build` were
deliberately NOT run in this session — only `tsc --noEmit` + the focused
vitest runs above. `scripts/land.sh` was not run either (no push/PR from this
session).

## Follow-ups

- No dashboard surfacing of the new `usage_budget_status` / `usage_budget_enforced`
  audit rows yet — a future slice could add a small admin panel widget reading
  these receipts (similar to the existing connections-health page's
  "usage-monitor" row) so the owner doesn't have to query the audit log
  directly to see the advisory preview.
- The advisory line is currently Bull-only, matching the existing
  `drawdownAdvisory` precedent. If a future review decides `drawdownAdvisory`
  should also reach the Bear for evidence parity, `budgetAdvisory` should
  follow the same change at the same time (keep them consistent).
- `previewBudgetDecision` and `evaluateBudgetForRun` both call
  `getBudgetStatusCached()` — within one run they share the TTL cache so there
  is only one network round-trip to the monitor per run; this was verified via
  the integration test but is worth remembering if the choke-point ordering
  ever changes.
- Two sibling lanes (`claude/due-jobs-substrate`, `claude/prompt-safety-fencing`)
  were flagged as landing before this one and touching adjacent
  `strategy.ts`/`strategy-prompts.ts`/`learned-context/store.ts` regions. This
  lane's `strategy.ts` diff was kept as localized as possible (two new
  try/catch blocks at existing choke points, one new import line, one new
  field threaded through `proposeTrades`) to keep the eventual merge trivial,
  but line numbers will still drift — locate by symbol
  (`checkBudgetAndAlert`, `usage_budget_status`, `usage_budget_enforced`,
  `evaluateBudgetForRun`) rather than by line number when rebasing.
