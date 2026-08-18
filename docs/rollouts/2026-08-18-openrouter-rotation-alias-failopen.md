# 2026-08-18 — OpenRouter 404s are not "not on your account"

## Context & Objective

Jay reported Green Team failed because models are not available on his OpenRouter account.  That is false: live `/api/health` at 2026-08-18 ~17:20Z had OpenRouter credits above the $3 floor, `tradingLivenessDegraded` true, and last completed Green ~9:37am CT Aug 17 (~27h).  Rotation (`__rotate__`) must keep running.  Do not require adding models in the OpenRouter dashboard.  Do not treat `require_parameters` as the only cause.

## Changes Made

**Two live causes, same false sentence.**  `humanizeLlmError` treated any HTTP 404 as "That model isn't available on your OpenRouter account."  We still do not have a Coolify last-run body.

1. **#2771 routing 404.**  Live (`f75027c1`, 2026-08-17T14:17:36Z, now in prod `cda485ff`).  Every OpenRouter LLM body set `provider.require_parameters=true`.  OpenRouter then 404s `No endpoints found matching your request` when no endpoint advertises every field.  `allow_fallbacks` only covers 5xx / rate-limit within a model — it does not revive that empty set.

2. **Untilded `-latest` wire ids (live catalog, 2026-08-18).**  GET `https://openrouter.ai/api/v1/models` returned 413 models.  OpenRouter's `-latest` aliases use a `~` prefix.  `normalizeOpenRouterModelId` emitted them without `~`, so those ids are not in the catalog and chat/completions 404s.  Same class as #2770/#2771 (mistral-medium-3.5 period 404).  The 2026-07-20 rollout already required the tilde (`docs/rollouts/2026-07-20-openrouter-latest-alias.md`, #1864/#1894); the current normalizer lost it.

Verified live ids (do not invent slugs):

| ST used to send | In catalog? | Actual catalog ids |
|---|---|---|
| anthropic/claude-sonnet-latest | no | ~anthropic/claude-sonnet-latest, anthropic/claude-sonnet-5 |
| anthropic/claude-haiku-latest | no | ~anthropic/claude-haiku-latest, anthropic/claude-haiku-4.5 |
| anthropic/claude-opus-latest | no | ~anthropic/claude-opus-latest, anthropic/claude-opus-5 |
| anthropic/claude-fable-latest | no | ~anthropic/claude-fable-latest, anthropic/claude-fable-5 |
| x-ai/grok-latest | no | ~x-ai/grok-latest, x-ai/grok-4.5 |
| openai/gpt-mini-latest | no | ~openai/gpt-mini-latest, openai/gpt-5.4-mini |
| moonshotai/kimi-latest | no | ~moonshotai/kimi-latest |
| deepseek/deepseek-reasoner | no | deepseek/deepseek-r1 |

Catalog shorts (`claude-sonnet-5`, `claude-haiku-4.5`, `grok-4.5`, `gpt-5.4-mini`) went through the same normalizer and became the missing `-latest` form.

`isOpenRouterModelAvailable()` compared `anthropic/claude-sonnet-latest` to `/models/user` ids that have `~` or the dated slug, so rotation skipped Claude even when the probe succeeded.

Ops snapshot (same window) showed rotation already picking `mistral-medium-3-5` / `gemini-3.7-flash` / `mistral-small-2603` — not an empty pool.

- Wire ids prefer the dated public id when it exists; otherwise the live `~author/slug-latest` row (`~moonshotai/kimi-latest`).
- Availability treats `~` as optional and matches dated ↔ latest aliases.
- `require_parameters` only when the body sends `max_completion_tokens` on an OpenAI reasoning model.  Gemini / Mistral / Claude / embeds stay on OpenRouter's default false.  `allow_fallbacks` stays true.
- 404 "No endpoints found matching your request" says no compatible endpoint.  Bare 404 says couldn't complete.  True `model_not_found` is a bad-slug sentence, not an account-privacy sentence.
- Green/Red failover leaves a 404/403 model for the next chain entry.  `llmFetch` still does not retry 404 on the same model.
- If a successful allowlist would empty a keyed pool, fail OPEN minus `kimi-latest` / `claude-fable-5`.

Touched files:

- `src/lib/llm-provider.ts`
- `src/lib/openrouter-model-availability.ts`
- `src/lib/model-identity.ts`
- `src/lib/llm-call.ts`
- `src/lib/chat/llm.ts`
- `src/lib/llm-errors.ts`
- `src/lib/llm-request.ts`
- `src/lib/strategy.ts`
- `src/lib/red-team.ts`
- `src/lib/model-rotation.ts`
- `src/lib/llm-required.ts`
- `app/console/components/chrome.tsx`
- `test/llm-provider.test.ts`
- `test/openrouter-model-availability.test.ts`
- `test/model-rotation.test.ts`
- `test/llm-errors.test.ts`
- `test/llm-call.test.ts`
- `test/llm-request.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`

## Decisions & Trade-offs

- Do not treat `require_parameters` as the only cause.  The lost `~` / dated-slug map is the same 404 class as #2770.
- Prefer dated public ids over the tilde alias when both exist, so chat/completions hits a stable catalog row.
- Kimi has no dated public "latest" row — only `~moonshotai/kimi-latest`.  Did not invent `kimi-k2.5` as the wire id.
- Did not invent a Coolify HTTP body.  Last-run `error_class` / slug / OpenRouter body are still unknown.
- Did not drop rotation.  Did not add models to Jay's OpenRouter dashboard.  Did not raise spend or touch the Congress $2 cap.  No Stripe / IAP.  No coordinator notes in product UI.

## Verification State

```bash
curl -sS https://openrouter.ai/api/v1/models   # 413 models, 2026-08-18
npm test -- test/llm-provider.test.ts test/llm-errors.test.ts \
  test/llm-call.test.ts test/model-rotation.test.ts \
  test/openrouter-model-availability.test.ts test/model-identity.test.ts
                          # 96 passed
```

Required coverage: (a) 404 "No endpoints found matching your request" does not produce the account sentence; (b) `model_not_found` is a bad-slug sentence, not account-privacy; (c) allowlist that matches nothing fail-opens minus dead slugs; (d) live catalog table above — ST no longer emits the missing untilded `-latest` ids.

Full `npm test` not claimed: unrelated suites hang on this VM's outbound network.  `xcodebuild` was not run (no `ios/**` product change).

## Next Steps & Blockers

- After merge/auto-deploy, Green rotate should send dated or tilde catalog ids and should not call a routing 404 an account miss.
- If chat/completions still 404s every model, inspect the raw OpenRouter body (we still do not have one) before adding more provider knobs.

## Zero-Code Findings

- Production health 2026-08-18 ~17:24Z: `ok` true, `openrouterCredits.ok` true (`thresholdUsd` 3), scheduler age 0, `tradingLiveness.degraded` 1, `oldestCompletedRunAgeSeconds` 96349.
- Live OpenRouter catalog 2026-08-18: 11 `~` latest aliases.  Untilded `author/slug-latest` rows are absent for Claude / Grok / GPT-mini / Kimi.
- Recent Green failures (ops snapshot): Roth/Paper "That model isn't available on your OpenRouter account" on `mistral-medium-3-5` / `gemini-3.7-flash`; earlier 2026-08-17 400s on terra/luna/nano and the period-form Mistral slug.  Pool was not empty.
