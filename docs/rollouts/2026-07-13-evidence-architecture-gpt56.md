# Evidence architecture, account-scoped learning, and GPT-5.6

Date: 2026-07-13  
Owner: CODEX  
Branch: `codex/evidence-architecture-program`  
State at this checkpoint: local implementation complete; current-main reconciliation and full gate
pending; not pushed, merged, deployed, or production-verified.

## Summary

- Added account-scoped relational/vector learning and explicit, sample-gated paper-to-live research
  transfer. Legacy autonomous rows without reconstructable account provenance are quarantined.
- Removed the product Test Account create button/client helper/API creation/read exposure and added a
  production migration that purges legacy Test Accounts and associated simulated outcomes. The test
  broker remains unit-test infrastructure only.
- Widened pre-enrichment selection, added field-level evidence/failure receipts and deterministic
  source arbitration, deduplicated republished analyst consensus by upstream family, and retained
  source disagreements.
- Added immutable evidence references/packs, Green/Red evidence parity, exact opening-candidate
  enforcement, point-in-time retrieval, global context budgets, prompt-data containment, source
  coverage, shadow source ablations, and outcome-linked source-value telemetry.
- Applied the same containment/budget/evidence contract to Coach/chat, strategy tuning, Framework
  review, and learning review.
- Added GPT-5.6 Luna/Terra/Sol to all LLM surfaces with provider-supported reasoning effort and
  role-specific recommendations. Removed full GPT-5.4/5.5 from curated selectors while retaining
  Mini/Nano and custom/stored legacy IDs.

## Why

The app already gathered broad market, broker, filing, web, outcome, and learning data, but several
boundaries lost decision value: enrichment happened after a narrow rank; scalar merges hid source
quality/failure; Green and Red contexts could drift; paper/live and sibling-account learning could
contaminate each other; and each LLM surface budgeted/contained external text differently. The new
contracts make source use inspectable, account boundaries explicit, and outcome attribution possible
without pretending observational ablation is causal.

The source-by-source audit and residual gaps are documented in
`docs/reviews/2026-07-13-decision-evidence-architecture.md`.

## Files

Application/API/UI:

- `app/api/chat/route.ts`
- `app/api/connected-accounts/route.ts`
- `app/api/policy/route.ts`
- `app/console/assistant/chat.tsx`
- `app/console/assistant/models.tsx`
- `app/console/components/chrome.tsx`
- `app/console/lib/derive.ts`
- `app/console/lib/models.ts`
- `app/console/settings/brokers.tsx`
- `app/console/settings/learning-review.tsx`
- `app/console/settings/lib.ts`
- `app/console/strategy/page.tsx`
- `app/ui/llm-model-catalog.ts`

Core implementation:

- `src/lib/chat/llm.ts`
- `src/lib/chat/orchestrator.ts`
- `src/lib/chat/prompt.ts`
- `src/lib/data-providers.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/db-learning.ts`
- `src/lib/db-profiles.ts`
- `src/lib/db.ts`
- `src/lib/evidence-budget.ts`
- `src/lib/evidence-facts.ts`
- `src/lib/evidence-pack.ts`
- `src/lib/evidence.ts`
- `src/lib/execution-mode.ts`
- `src/lib/experience-memory.ts`
- `src/lib/framework-review.ts`
- `src/lib/learned-context/store.ts`
- `src/lib/learning-review.ts`
- `src/lib/learning-transfer.ts`
- `src/lib/llm-request.ts`
- `src/lib/llm-usage.ts`
- `src/lib/market.ts`
- `src/lib/model-reasoning-recommendations.ts`
- `src/lib/model-rotation.ts`
- `src/lib/outcome-engine.ts`
- `src/lib/performance.ts`
- `src/lib/post-mortem.ts`
- `src/lib/prompt-safety.ts`
- `src/lib/socratic-memory.ts`
- `src/lib/source-value.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/strategy.ts`
- `src/lib/types.ts`
- `src/lib/usage-budget.ts`
- `src/lib/vector-db.ts`

Tests:

- `test/chat-injection.test.ts`
- `test/chat-llm.test.ts`
- `test/connected-accounts-route.test.ts`
- `test/data-providers.test.ts`
- `test/evidence-pack.test.ts`
- `test/experience-memory.test.ts`
- `test/learned-context-account-scope.test.ts`
- `test/learned-context-delete.test.ts`
- `test/learned-context-pending.test.ts`
- `test/learned-context-sharing.test.ts`
- `test/learned-context.test.ts`
- `test/learning-review-policy-route.test.ts`
- `test/learning-review.test.ts`
- `test/llm-request.test.ts`
- `test/market-preselection.test.ts`
- `test/model-rotation.test.ts`
- `test/persistence-hardening.test.ts`
- `test/prompt-safety.test.ts`
- `test/rag-doc-type-coverage.test.ts`
- `test/source-value.test.ts`
- `test/strategy-candidate-enforcement.test.ts`
- `test/strategy-episodic-injection.test.ts`
- `test/strategy-held-position-retrieval-scope.test.ts`
- `test/strategy-prompt-safety.test.ts`
- `test/strategy-tuning-reviews.test.ts`
- `test/vector-db-retrieval.test.ts`

Records/design:

- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board)
- `docs/chat-assistant-rag-learning.md`
- `docs/manager-model-options.md`
- `docs/phase-7-strategy.md`
- `docs/phase-9-web-sources.md`
- `docs/reviews/2026-07-13-decision-evidence-architecture.md`
- `docs/rollouts/2026-07-13-evidence-architecture-gpt56.md`

## Decisions

- Keep real broker paper accounts. Their outcomes stay exact-account scoped; only a corroborated
  aggregate thesis statement transfers to cross-account research.
- Delete the product Test Account, but preserve `TestBrokerGateway`/`broker: "test"` strictly for
  deterministic unit/integration tests.
- Treat source-value telemetry as observational and selection-biased. It may guide investigation,
  never automatically reweight source trust.
- Use Terra/Medium as the provisional OpenAI Green recommendation, Sol/High for Red and consequential
  review, and Luna/Low for high-volume Coach. Keep Mini/Nano because they remain cheaper than Luna.
- Do not request earnings-transcript RAG until a real licensed producer exists.
- No production configuration changes or corpus writes are part of this branch.

## Verification

Completed before current-main reconciliation:

- `npm run lint` — pass, 0 errors (435 grandfathered warnings).
- `npx tsc --noEmit` — pass.
- `npx vitest run test/model-rotation.test.ts test/llm-request.test.ts test/chat-llm.test.ts test/chat-injection.test.ts test/chat-orchestrator.test.ts test/chat-draft-policy.test.ts test/learning-review.test.ts test/learning-review-policy-route.test.ts test/framework-review.test.ts test/strategy-tuning.test.ts test/strategy-tuning-reviews.test.ts test/source-value.test.ts test/evidence.test.ts test/performance.test.ts test/strategy-prompt-safety.test.ts` — 15 files, 224 tests pass.
- `npx vitest run test/persistence-hardening.test.ts test/connected-accounts-route.test.ts test/model-rotation.test.ts` — 3 files, 41 tests pass.
- `git diff --check` — pass before documentation edits.

Required final gate after merging current `origin/main`:

- `npm run lint`
- `npx tsc --noEmit`
- `npm test`
- `npm run build`

## Follow-ups / risks

- `origin/main` advanced during implementation with database migrations 20–22 and Red Team fallback
  UI. This branch reserves migrations 23–24; merge conflicts must be reconciled before final verify.
- Source/provider recommendation quality starts with priors. Re-adjudicate from account-scoped
  realized outcomes after enough data accrues.
- Add an operator source-value dashboard only after enough directional outcomes exist.
- Continue the separate staged SEC backfill/occurrence-provenance program; this branch improves
  retrieval consumption but does not claim complete corpus coverage.
