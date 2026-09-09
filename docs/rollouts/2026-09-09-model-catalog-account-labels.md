# Model catalog refresh and concise account labels

## Context & Objective

Refresh the web app's provider choices against current offerings and remove repeated paper-account explanations from the header.  Preserve explicit account/model selections and historical model aliases.

## Changes Made

- Add GPT-6 Astra/Astra Pro, MiniMax M3/M2.7, Meta Muse Spark 1.3/Glimmer 30B, and Llama 4 Maverick/Scout.
- Update Fable to 5.1, Grok to 4.6, Gemini Flash batch to 3.8, and DeepSeek V4 OpenRouter routes to the latest stable snapshots; correct Mistral wire IDs and Anthropic native IDs.
- Add MiniMax credential, endpoint, picker, and attribution support with ordinary pay-as-you-go API credentials.
- Render only `PAPER TRADING  •  broker-provided practice account` in the paper banner.  Use `PAPER` pills, omit dropdown practice-account explanations, and show a single collapsed account-name row with three spaces before an em dash and the final four account characters.

Exact touched files:

- `PLAN.md`
- `STATUS.md`
- `app/api/chat/providers/route.ts`
- `app/api/keys/route.ts`
- `app/api/policy/route.ts`
- `app/console/components/chrome.tsx`
- `app/console/lib/derive.ts`
- `app/console/lib/models.ts`
- `app/ui/llm-model-catalog.ts`
- `docs/EFFORT-LOG.md`
- `docs/manager-model-options.md`
- `src/lib/chat/llm.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/llm-call.ts`
- `src/lib/llm-errors.ts`
- `src/lib/llm-model-catalog.ts`
- `src/lib/llm-provider.ts`
- `src/lib/llm-request.ts`
- `src/lib/llm-usage.ts`
- `src/lib/model-reasoning-recommendations.ts`
- `src/lib/model-rotation.ts`
- `src/lib/provider-tier-plan.ts`
- `src/lib/sentry-gen-ai.ts`
- `src/lib/usage-budget.ts`
- `test/chat-openrouter-routing.test.ts`
- `test/console-models.test.ts`
- `test/llm-call.test.ts`
- `test/llm-errors.test.ts`
- `test/llm-model-catalog.test.ts`
- `test/llm-provider.test.ts`
- `test/llm-request.test.ts`
- `test/model-rotation.test.ts`
- `test/openai-model-catalog.test.ts`
- `test/sentry-gen-ai.test.ts`
- `docs/rollouts/2026-09-09-model-catalog-account-labels.md`

## Decisions & Trade-offs

The live OpenRouter model feed was fetched on 2026-09-09 from https://openrouter.ai/api/v1/models.  Moving family aliases remain persisted identities; historical aliases remain accepted.  No account settings, model defaults, provider priority, subscription, or trading permissions are changed.  Save/rotation eligibility now follows the same OpenRouter-first/native-fallback credential resolution as execution, allowing a native MiniMax key to be selected.

MiniMax's Token Plan supports compatible developer tools but targets individual interactive development and recommends pay-as-you-go for production.  The app therefore exposes standard API credentials, without promising that a coding subscription covers automated application usage.

Sources:
- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://platform.claude.com/docs/en/models/overview
- https://docs.x.ai/developers/models/grok-4.6
- https://ai.google.dev/gemini-api/docs/models
- https://platform.minimax.io/subscribe/token-plan
- https://platform.minimax.io/subscribe/token-plan?tab=api-enterprise
- https://platform.minimax.io/docs/api-reference/text-openai-api

The screenshot request concerns the web console; native iOS screens are outside this change.

## Verification State

In progress; no passing full gate or deployment claim.

- `npm ci --ignore-scripts`: registry connection resets/timeouts; stopped.
- Independent copy of integration `node_modules` completed; one truncated Zod file was recopied from the intact source after ESLint detected its syntax error.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint`: stopped after 13 minutes under severe shared-Mac load; incomplete.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx --no-install tsc --noEmit`: stopped after 13 minutes under severe shared-Mac load; incomplete.
- `git diff --check`: passed.
- Live OpenRouter feed: all added catalog wire IDs verified present.

Observed Mac load reached 603.  The draft branch is being published to run `.github/workflows/ci.yml` on GitHub-hosted infrastructure (lint, typecheck, tests, build in order); this is validation of unfinished work, not a completed landing or a bypass of required merge checks.

Hosted CI run `34326303260`: lint passed; typecheck found a MiniMax-only option accidentally copied into the Anthropic path.  Removed that option and the unrelated family predicate from Anthropic before rerunning.  Tests/build were skipped by the failed typecheck.

Actual header component browser fixture: `node /tmp/st-ui-qa-20260909/check.cjs` passed desktop paper/live and mobile paper checks, exact banner text/spacing, one-row trigger, PAPER chips, Escape dismissal, no horizontal overflow, and no page errors.  Fixture uses test accounts and does not establish production connectivity.

Focused verification: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx --no-install vitest run test/llm-model-catalog.test.ts test/llm-provider.test.ts test/llm-request.test.ts test/llm-call.test.ts test/chat-openrouter-routing.test.ts test/console-models.test.ts test/llm-errors.test.ts test/model-rotation.test.ts test/sentry-gen-ai.test.ts`: 7 suites / 126 tests passed; catalog/provider suites failed their 60-second setup hooks (16 tests skipped) under shared-Mac load.  This is not a passing targeted gate.

Reran the two timed-out suites with `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx --no-install vitest run test/llm-model-catalog.test.ts test/llm-provider.test.ts --maxWorkers=1 --hookTimeout=120000`: 2 suites / 16 tests passed.  Corrected the native Grok expectation from 4.5 to 4.6 to match the refreshed alias.  Across focused runs all 142 tests passed.

Apple Notes living note updated successfully in Coding; pin shortcut unavailable.

Hosted run `34327205131`: lint/typecheck passed; full suite reported 7,884 passed, 51 skipped, and two stale expectations (native Grok 4.5 and the pre-Astra OpenAI list).  Both fixtures are corrected; rerun pending.  No runtime test failure remained in the report.  Separate read-only provider review found no concrete remaining P1/P2 issue.

Astra Pro is also included through its verified OpenRouter route (`openai/gpt-6-astra-pro`); native routing is disabled because its native API model page returned 404.  Catalog entries can explicitly require OpenRouter.

Final provider cross-check identified Muse Spark 1.3 (Meta announcement 2026-09-02) and Glimmer 30B in the live OpenRouter feed; added both.  Meta is explicitly OpenRouter-only in this app: the prior native fallback had no Meta endpoint and would send a stored Meta key to OpenAI.  Eligibility, strategy, chat, and provider availability now fail closed without OpenRouter.  Added request-headroom and credential-boundary regression coverage.  Sources: https://ai.meta.com/llama and https://openrouter.ai/api/v1/models.

Exact-lockfile local reinstall also failed with `ETIMEDOUT`.  Hosted verification remains required.

GitHub review correctly identified native `claude-opus-5` missing from the adaptive-thinking matcher.  Added Opus 5 matching and a native chat transport regression; all native Anthropic chat calls now use the shared 4,096-token minimum.  Grok 4.5/4.6 match current reasoning controls (no off switch, xhigh on 4.6); Gemini 3.8 matches mandatory low/medium/high thinking.  Sources: https://docs.x.ai/developers/model-capabilities/text/reasoning and https://ai.google.dev/gemini-api/docs/thinking.

## Next Steps & Blockers

PR #3196 is in review pending the final gate.  `PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh --draft` passed worktree/hook/stale-overlap checks (main already current) and failed local typechecking because the copied dependency tree lacks `@sentry/profiling-node` and has an empty `@types/node/url.d.ts`.  Hosted lint/typechecking passed.  Reinstalling the exact lockfile using `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci --ignore-scripts --prefer-offline`; do not alter source to accommodate damaged dependencies.  Hosted run `34327205131` validates commit `2a9519912`.  No merge or deployment claim.

## Zero-Code Findings

Documentation search results lagged the live OpenRouter catalog for several September releases.  Exact API identifiers and provider-native spellings were cross-checked before changing the catalog.

## Review follow-up

Hosted lint, typecheck, and tests passed on `aec6c040a`; build is pending.  Auto-merge is disabled until follow-up fixes are validated.

- Chat availability and API preflight follow tenant-scoped OpenRouter-first/native-fallback execution, including OpenRouter-only models.
- Budget enforcement and preview use the credential service actually selected for the user, ignoring unrelated provider spend.
- MiniMax structured requests include their schema in the system prompt on native and OpenRouter routes.  OpenRouter retains its advertised structured-output format; native-only `reasoning_split` is not sent through OpenRouter.
- `scripts/infisical-secrets-safe.sh` rejects `MINIMAX_API_KEY` writes.  Verified with `bash scripts/infisical-secrets-safe.sh set MINIMAX_API_KEY=placeholder` (expected refusal).
- Updated the on-demand helper row in `/Users/jay/apps/MAC-LOCAL-PROCESSES.md` and refreshed/pinned the existing Coding note `⭐️ Background Jobs Master List`.  No daemon was created.
- Learning-review selections and audit metadata use current catalog identities while retaining saved aliases; request resolution and provider-reported serving identity remain distinct.

Additional touched files: `app/api/chat/route.ts`, `app/console/assistant/chat.tsx`, `app/console/settings/learning-review.tsx`, `src/lib/learning-review.ts`, `src/lib/usage-budget.ts`, `src/lib/llm-call.ts`, `scripts/infisical-secrets-safe.sh`, and focused regression tests.  Final hosted gate pending.

Hosted run `34332320089` on `5f0d07ba6`: lint/types passed; 7,902 tests passed, 51 skipped, and four failures in `test/usage-budget-strategy-integration.test.ts`.  Those fixtures stored an OpenRouter key while reporting OpenAI budget spend; correcting the payload provider to OpenRouter preserves their intended enforcement/advisory tests under the actual-route budget fix.  Updated the advisory assertion accordingly.  No runtime change was needed.  Full gate rerun pending; auto-merge disabled until validation.
