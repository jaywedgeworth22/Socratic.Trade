# 2026-06-25 — Add Google Gemini + Mistral as LLM providers (model-name routed)

## Summary
Two more LLM providers, wired exactly like xAI/Grok: the provider is derived from the model-name
prefix, so a user just picks a `gemini-*` or `mistral-*` model in Settings and it routes to that
provider with that provider's key. Both expose OpenAI-compatible chat/completions endpoints, so no
new transport was needed.

- **`src/lib/llm-provider.ts`** — `resolveLlmEndpoint`: added `gemini-*` → Gemini OpenAI-compat
  endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
  `GEMINI_API_URL` override) and `mistral|ministral|magistral|codestral|devstral|pixtral|open-mi*` →
  Mistral (`https://api.mistral.ai/v1/chat/completions`, `MISTRAL_API_URL` override). Both
  `transport: "chat-completions"`. Provider union widened to include `gemini`/`mistral`.
- **`src/lib/db-api-keys.ts`** — `GEMINI_API_KEY`/`MISTRAL_API_KEY` in the env map + aliases
  (`google_api_key`→gemini), `resolveLlmCredential` service type widened, and both added to the
  boot env→store migration list (per-user key resolution + operator failover, same as openai/xai).
- **`app/api/keys/route.ts`** — "Google Gemini" + "Mistral AI" rows in the connections key catalog.
- **`app/dashboard-client.tsx`** — Gemini + Mistral optgroups in both the Green Team and Red Team
  model selects (gemini-2.5-flash-lite/2.5-flash/3.5-flash; mistral-small/medium/large-latest).
- **`src/lib/llm-usage.ts`** — approximate per-1M pricing for the new models (advisory cost ledger).
- **`.env.example`** — `GEMINI_API_KEY`/`GEMINI_API_URL`, `MISTRAL_API_KEY`/`MISTRAL_API_URL`.
- **`test/llm-provider.test.ts`** — gemini/mistral routing + family (ministral/codestral) + URL overrides.

## Why
Owner wants Gemini and Mistral selectable alongside OpenAI/Grok/Anthropic. Endpoints + current model
ids verified live (Gemini OpenAI-compat is chat/completions only — not the Responses API; Mistral's
native API is OpenAI-shaped). Keys are credentials → live in the secrets manager (Infisical) / env,
not committed.

## Verification
`npx tsc --noEmit` clean · `npx vitest run` 1207 passed (+5 provider tests) · `npm run build` green.
Built in an isolated worktree off `origin/main`; landing via PR.

## Notes / follow-ups
- Gemini OpenAI-compat layer is officially still beta (some OpenAI params silently ignored; no
  Responses API; reasoning can't be disabled on 2.5 Pro / Gemini 3) — fine for our chat-completions
  usage. Mistral's `magistral-*` reasoning aliases are deprecated (reasoning now via reasoning_effort
  on medium/small); we expose the dense `-latest` aliases.
- Pricing entries are approximate — verify against provider pricing pages if cost accuracy matters.
- Keys resolve per-user with operator-env failover (LLM_OPERATOR_FALLBACK), identical to OpenAI/xAI.
