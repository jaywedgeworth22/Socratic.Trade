# 2026-07-01 — Durable per-user/day LLM budget: modifiable config + spend-primitive enforcement

Follow-up on PR #293 (branch `claude/audit-work-split-f-g-o67jj2`). Replaces the call-site-by-call-site
budget gating (which Codex kept finding new bypasses for — RAG retrieval, revalidation, reflection…)
with a **durable** design: one config source, two spend-primitive choke points.

## Summary / Why

The G8 daily LLM budget ceiling was (a) **operator-env-only** (`TRIGGER_LLM_DAILY_TOKEN_BUDGET` /
`_COST_BUDGET_USD`) — not user-modifiable — and (b) enforced at individual call sites, so every new
model/embedding spend site was a fresh bypass. This change makes it **modifiable per-user** and
**airtight** by enforcing at the primitives every spend flows through.

### Config — who sets it / how to modify it
- New per-user **policy** fields `policy.tuning.llmDailyTokenBudget` and `llmDailyCostBudgetUsd`
  (`src/lib/types.ts`).
- **Editable in the dashboard** Settings → Tuning (two `OptionalNumberField`s in
  `app/dashboard-client.tsx`; blank/0 = no limit) and via `PATCH /api/policy` (validated in
  `app/api/policy/route.ts`: non-negative numbers).
- `checkLlmDailyBudget(userId)` now reads the **policy value first**, falling back to the operator
  **env default**, else off. So: operator sets a default via env; the account owner overrides it in the
  UI/API. Resilient policy read (degrades to env-only if policy can't be read — never throws from
  bookkeeping).

### Enforcement — two durable spend primitives (covers current + future sites)
- **All LLM generations** flow through `withLlmGeneration` (bull, bear, red-team, revalidation,
  reflection, tuning). It now calls `assertWithinLlmBudget(options.userId)` **before** running the
  model call (and before the Langfuse short-circuit), throwing `LlmBudgetExceededError` when over
  budget. (`src/lib/observability.ts`, `src/lib/llm-budget.ts`.)
- **All RAG retrieval** flows through `retrieveContextDetailed`, which now returns `[]` (no Voyage
  embed, no Pinecone query, no metered spend) when `isOverLlmBudget(userId)`. (`src/lib/vector-db.ts`.)
- `generateReflectionSummary` also self-gates early (avoids a wasted 50-row fetch before the backstop).
- The strategy still computes `skipLlmDueToBudget` once after its non-LLM risk breakers to skip
  revalidation + generation *gracefully* (no throw on the hot path); the primitives are the durable
  backstop for everything else.
- Non-LLM safety (drawdown/volatility breakers, reconciliation, protective exits) always runs — the
  ceiling only stops *spend*.

## Files

- `src/lib/types.ts` — `TuningSettings.llmDailyTokenBudget` / `llmDailyCostBudgetUsd`.
- `src/lib/llm-budget.ts` — policy-aware `checkLlmDailyBudget` (env fallback, resilient); new
  `isOverLlmBudget`, `assertWithinLlmBudget`, `LlmBudgetExceededError`.
- `src/lib/observability.ts` — `withLlmGeneration` budget backstop.
- `src/lib/vector-db.ts` — `retrieveContextDetailed` RAG self-gate.
- `src/lib/post-mortem.ts` — `generateReflectionSummary` self-gate.
- `app/api/policy/route.ts` — validation for the two new fields.
- `app/dashboard-client.tsx` — two Settings → Tuning controls (Daily LLM token/cost budget).
- Tests: `test/llm-budget-enforcement.test.ts` (config precedence/fallback/default-off + primitive
  enforcement); `test/query-embedding-cache.test.ts` db-mock updated for the new policy read.

## Verification

`npx tsc --noEmit` 0 errors · `npm run lint` 0 errors · `npm test` **1738/1738** · `npm run build` ok.
(Private `@jaywedgeworth22/congress-trading-shared` stubbed locally as before; CI `verify` uses the real
package.)

## Follow-ups

- The per-user **concurrent-run reservation** (two same-user account runs both passing the read-based
  admission check) is still a documented, deferred limitation — the spend-primitive gate makes the
  ceiling airtight *within* a run and across sites, but two concurrent runs can still each start just
  under the limit. A true reservation is a separate concurrency change.
- Chat (`/api/chat`) LLM spend is not routed through `withLlmGeneration`, so it isn't covered by this
  gate; if a *total* per-user/day ceiling (incl. chat) is wanted, wire chat's LLM path through the same
  `assertWithinLlmBudget` — noted as a follow-up.
