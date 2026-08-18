# 2026-08-18 — OpenRouter "No endpoints" 404 is not "not on your account"

## Context & Objective

Jay reported Green Team failed because models are not available on his OpenRouter account.  That is false: live `/api/health` at 2026-08-18 ~17:20Z had OpenRouter credits above the $3 floor, `tradingLivenessDegraded` true, and last completed Green ~9:37am CT Aug 17 (~27h).  Rotation (`__rotate__`) must keep running.  Do not require adding models in the OpenRouter dashboard.

## Changes Made

**Primary liar (live-path receipts):** #2771 is live (`f75027c1`, 2026-08-17T14:17:36Z, now in prod `cda485ff`).  Every OpenRouter LLM body set `provider.require_parameters=true`.  OpenRouter then 404s `No endpoints found matching your request` when no endpoint advertises every field.  `allow_fallbacks` only covers 5xx / rate-limit within a model — it does not revive that empty set.  `humanizeLlmError` treated **any HTTP 404** as "That model isn't available on your OpenRouter account."  We do not have a Coolify last-run body; the classifier + routing are coded so this class of 404 cannot lie again.

**Secondary:** `/models/user` rotation already fail-OPENs after 2026-08-13.  `availability_unavailable` copy only if that fail-open pool is empty, which is unlikely when the OpenRouter key resolves catalog models.  Exact-id alias miss is still hardened.

Ops snapshot (same window) showed rotation already picking `mistral-medium-3-5` / `gemini-3.7-flash` / `mistral-small-2603` — not an empty pool.

- `require_parameters` only when the body sends `max_completion_tokens` on an OpenAI reasoning model (the #2771 nano case).  Gemini / Mistral / Claude / embeds stay on OpenRouter's default false.  `allow_fallbacks` stays true.
- 404 "No endpoints found matching your request" (and similar routing 404s) says the provider had no compatible endpoint.  The account-allowlist sentence is only for a real model-not-found / no-access body, never `status === 404` alone.
- Green/Red failover leaves a 404/403 model for the next chain entry (`isFailoverLlmStatus`).  `llmFetch` still does not retry 404 on the same model.
- Match `/models/user` rows by family identity; if a successful allowlist would empty a keyed pool, fail OPEN minus `kimi-latest` / `claude-fable-5`.
- `model_rotation_pick` audits now include `skipped` + `availability` + `availabilityError`.

Touched files:

- `src/lib/llm-call.ts`
- `src/lib/chat/llm.ts`
- `src/lib/llm-errors.ts`
- `src/lib/llm-request.ts`
- `src/lib/strategy.ts`
- `src/lib/red-team.ts`
- `src/lib/openrouter-model-availability.ts`
- `src/lib/model-rotation.ts`
- `src/lib/llm-required.ts`
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

- Primary fix is the 404 classifier + narrowing `require_parameters`.  OpenRouter docs (provider-selection, 2026-08-18): `require_parameters` default is false; when true, unsupported-parameter endpoints never receive the request; `allow_fallbacks` does not reopen that empty set.
- Did not invent a Coolify HTTP body.  Last-run `error_class` / slug / OpenRouter body are still unknown.
- `/models/user` fail-open is secondary.  Live runs were already picking concrete slugs.
- Did not drop rotation.  Did not add models to Jay's OpenRouter dashboard.  Did not raise spend or touch the Congress $2 cap.  No Stripe / IAP.  No coordinator notes in product UI.

## Verification State

```bash
npm run lint          # first pass: 0 errors (768 grandfathered warnings)
npx tsc --noEmit      # first pass: clean
npm test -- test/openrouter-model-availability.test.ts \
  test/model-rotation.test.ts test/llm-errors.test.ts test/llm-request.test.ts
                          # first pass: 65 passed
npm test -- test/llm-provider.test.ts test/strategy-llm-failover.test.ts \
  test/strategy-run-once-async-route.test.ts test/redteam-failure-routing.test.ts
                          # first pass: 32 passed
npm test -- test/llm-errors.test.ts test/llm-call.test.ts \
  test/model-rotation.test.ts test/openrouter-model-availability.test.ts
                          # after require_parameters narrowing: 82 passed
npm run build         # first pass: Next.js 16.3.1 webpack build clean
```

Required coverage on this pass: (a) 404 "No endpoints found matching your request" (plain + JSON-wrapped) does not produce the account sentence — it says no compatible endpoint; (b) `model_not_found` + 404 still uses the account sentence; (c) allowlist that matches nothing fail-opens minus `kimi-latest` / `claude-fable-5`.  Nano still sets `require_parameters: true`; Gemini / Mistral strategy bodies set `false`.

Full `npm test` was started and then stopped: unrelated suites hung/failed on this VM's outbound network (SEC company_tickers 404, TwelveData, RAG coverage).  Not a product regression from this PR.  `xcodebuild` was not run (no `ios/**` product change).

## Next Steps & Blockers

- After merge/auto-deploy, the next Green rotate run should not call a require_parameters 404 an account miss.  Gemini / Mistral should route without `require_parameters`.
- If chat/completions still 404s every model, inspect the raw OpenRouter body (we still do not have one) before adding more provider knobs.

## Zero-Code Findings

- Production health 2026-08-18 ~17:24Z: `ok` true, `openrouterCredits.ok` true (`thresholdUsd` 3), scheduler age 0, `tradingLiveness.degraded` 1, `oldestCompletedRunAgeSeconds` 96349.
- Recent Green failures (ops snapshot): Roth/Paper "That model isn't available on your OpenRouter account" on `mistral-medium-3-5` / `gemini-3.7-flash`; earlier 2026-08-17 400s on terra/luna/nano and the period-form Mistral slug.  Pool was not empty.
