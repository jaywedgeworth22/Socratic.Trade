# Model catalog refresh and concise account labels

## Context & Objective

Refresh the web app's provider choices against current offerings and remove repeated paper-account explanations from the header.  Preserve explicit account/model selections and historical model aliases.

## Changes Made

- Add GPT-6 Astra, MiniMax M3/M2.7, and Llama 4 Maverick/Scout.
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

## Next Steps & Blockers

Finish provider compatibility checks, run lint/typecheck/tests/build, inspect rendered UI, and land through the repository PR flow.

## Zero-Code Findings

Documentation search results lagged the live OpenRouter catalog for several September releases.  Exact API identifiers and provider-native spellings were cross-checked before changing the catalog.
