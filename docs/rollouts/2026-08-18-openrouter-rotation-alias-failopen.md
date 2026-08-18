# 2026-08-18 — OpenRouter rotation alias miss is not "not on your account"

## Context & Objective

Jay reported Green Team failed because models are not available on his OpenRouter account.  That is false: live `/api/health` at 2026-08-18 ~17:20Z had OpenRouter credits above the $3 floor, `tradingLivenessDegraded` true, and `oldestCompletedRunAgeSeconds` ~96k (~27h).  Rotation (`__rotate__`) must keep running.  Do not require adding models in the OpenRouter dashboard.

## Changes Made

Live ops snapshot (same window) showed rotation was already picking concrete models (`mistral-medium-3-5`, `gemini-3.7-flash`, `mistral-small-2603`) and dying on chat/completions.  The user-visible sentence came from `humanizeLlmError`: any HTTP 404 became "That model isn't available on your OpenRouter account."  The empty-pool / alias-miss path is a real second liar (exact `normalizeOpenRouterModelId` keep-only filter) but was not what emptied today's Green runs.

- Match `/models/user` rows by family identity so versioned ids keep catalog aliases (`claude-haiku-4.5` ↔ `anthropic/claude-haiku-latest`, `*-latest` ↔ current class, vendor prefix optional).
- If a successful allowlist would empty an otherwise keyed credential pool, fail OPEN minus `kimi-latest` / `claude-fable-5`.
- Say a model is missing from the OpenRouter account only when chat/completions 404/403 body is model-not-found / no-access.  Bare 404 / "No endpoints found" / `/models/user` timeout or alias miss is "couldn't check" or silent fail-open.
- Green/Red failover now leaves a 404/403 model for the next chain entry (`isFailoverLlmStatus`).  `llmFetch` still does not retry 404 on the same model.
- `model_rotation_pick` audits now include `skipped` + `availability` + `availabilityError`.

Touched files:

- `src/lib/openrouter-model-availability.ts`
- `src/lib/model-rotation.ts`
- `src/lib/llm-required.ts`
- `src/lib/llm-errors.ts`
- `src/lib/llm-request.ts`
- `src/lib/strategy.ts`
- `src/lib/red-team.ts`
- `app/console/components/chrome.tsx`
- `test/openrouter-model-availability.test.ts`
- `test/model-rotation.test.ts`
- `test/llm-errors.test.ts`
- `test/llm-request.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`

## Decisions & Trade-offs

- Did not treat the empty-pool hypothesis as proven.  Live runs were not `empty_pool` / `availability_unavailable`; they served wire slugs and classified the chat error as an account miss.
- Did not flip `provider.require_parameters`.  That 2026-08-17 nano routing knob may still produce "No endpoints found" 404s, but the body is not proof on this snapshot.  Copy + failover are the honest fix without inventing that root cause.
- Did not drop rotation.  Did not add models to Jay's OpenRouter dashboard.  Did not raise spend or touch the Congress $2 cap.  No Stripe / IAP.  No coordinator notes in product UI.

## Verification State

Focused vitest on the touched suites, then `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.  `xcodebuild` was not run (no `ios/**` product change).

## Next Steps & Blockers

- After merge/auto-deploy, the next Green rotate run should either serve or fail over instead of dying on the first 404 with an account lie.
- If chat/completions still 404s every model after failover, inspect the raw OpenRouter body (likely `No endpoints found` vs true `model_not_found`) before touching `require_parameters`.

## Zero-Code Findings

- Production health 2026-08-18 ~17:24Z: `ok` true, `openrouterCredits.ok` true (`thresholdUsd` 3), scheduler age 0, `tradingLiveness.degraded` 1, `oldestCompletedRunAgeSeconds` 96349.
- Recent Green failures (ops snapshot): Roth/Paper "That model isn't available on your OpenRouter account" on `mistral-medium-3-5` / `gemini-3.7-flash`; earlier 2026-08-17 400s on terra/luna/nano and the period-form Mistral slug.  Pool was not empty.
