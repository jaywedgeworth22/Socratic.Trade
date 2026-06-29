# 2026-06-29 — Claude as a first-class Green/Red Team model

## Summary

Claude (Anthropic) is now a first-class, selectable model for BOTH the Green Team
(Bull proposal generator) and the Red Team (Bear reviewer), alongside the existing
OpenAI/xAI/Gemini/Mistral/DeepSeek options. Previously Claude was only wired into
the Assistant chat and an env-gated Red-Team override (`RED_TEAM_LLM_PROVIDER=anthropic`);
the per-user Green/Red dropdowns and `resolveLlmEndpoint` only knew OpenAI-compatible
providers, and the strategy path leaned on OpenAI-only `response_format`/`json_schema`
params that Anthropic's Messages API rejects.

## Why

A previous session told the user Claude "can't be a Green/Red option because it can't
process JSON." That was half-true: the strategy/analysis call sites force structured
JSON via OpenAI's `response_format` (strict `json_schema`) / `text.format`, which
Anthropic doesn't accept. But Claude returns reliable JSON via its own mechanism —
**forced tool-use** (`tool_choice: { type: "tool", name }`), which the repo already
used for the env-gated Red-Team path. The fix is to route `claude-*` models through
the Anthropic Messages transport everywhere the strategy stack runs, not just chat.

## What changed

- **New transport** `anthropic-messages` (`src/lib/llm-request.ts`): added to a new
  `LlmTransport` union; `withLlmRequestBounds` now sets Anthropic's required top-level
  `max_tokens` (floored at 4096 to avoid truncating long tool-use JSON — Anthropic bills
  only emitted tokens, so the higher ceiling has no cost downside) and `temperature`.
- **Routing** (`src/lib/llm-provider.ts`): `resolveLlmEndpoint` now matches `claude-*`
  → `provider: "anthropic"`, `transport: "anthropic-messages"`, URL
  `https://api.anthropic.com/v1/messages` (override via `ANTHROPIC_API_URL`), Anthropic
  credential. Works for both Green and Red roles. `LlmEndpoint.provider` gained
  `"anthropic"`.
- **Shared request builder** (`src/lib/llm-call.ts`, NEW): `buildLlmRequestBody`,
  `llmAuthHeaders`, `extractLlmText` centralize per-transport shaping so every strategy
  call site is provider-agnostic. Anthropic uses `system` + `messages` + forced tool-use
  for schemas (and `x-api-key`/`anthropic-version` headers); OpenAI-compatible providers
  keep their exact prior behavior (strict `json_schema`; DeepSeek `json_object`).
  `extractLlmText` normalizes OpenAI chat/responses and Anthropic content blocks
  (a `tool_use` block's `input` is re-serialized to JSON) so callers `JSON.parse` uniformly.
- **Call sites refactored** to the shared builder (so Claude works as Green everywhere,
  not just the proposer): `src/lib/strategy.ts` (Bull + Bear), `src/lib/red-team.ts`
  (standalone debate, now with a forced-tool `red_team_verdict` schema for Claude while
  OpenAI keeps `json_object`), `src/lib/strategy-tuning.ts`, `src/lib/proposal-revalidation.ts`,
  `src/lib/post-mortem.ts` (free-text). Removed three now-duplicate local `extract*Text`
  helpers.
- **UI** (`app/dashboard-client.tsx`): added an "Anthropic (Claude)" optgroup
  (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`) to both the Green Team and
  Red Team selects; DRY'd the four duplicated model-id allow-lists into one
  `STRATEGY_MODEL_IDS` constant. `strategyLlmServiceForModel` + `LLM_SERVICE_LABELS` now
  map `claude-*` → `anthropic`, so the Settings key-gating warning covers a Claude Green model.
- **Key catalog copy** (`app/api/keys/route.ts`): the Anthropic entry now states it also
  unlocks the Green/Red Team, not just chat.

No change to the env-gated cross-provider override (`RED_TEAM_LLM_PROVIDER=anthropic` →
`debateViaAnthropic`); selecting a `claude-*` Red model is an independent, additive path.

## Files

- `src/lib/llm-request.ts`, `src/lib/llm-provider.ts`, `src/lib/llm-call.ts` (new),
  `src/lib/strategy.ts`, `src/lib/red-team.ts`, `src/lib/strategy-tuning.ts`,
  `src/lib/proposal-revalidation.ts`, `src/lib/post-mortem.ts`
- `app/dashboard-client.tsx`, `app/api/keys/route.ts`
- `test/llm-call.test.ts` (new), `test/llm-provider.test.ts`, `test/red-team.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-06-23-green-red-llm-routing.md` (follow-up)

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (grandfathered warnings only).
- `npm test` — 158 files / 1533 tests passed (incl. new Claude routing/red-team tests).
- `npm run build` — clean.
- Manual UI smoke against `npm run dev` — see PR walkthrough (Strategy Studio shows the
  Anthropic optgroup; selecting `claude-opus-4-8` persists for Green and Red).

## Follow-ups

- OpenAI strict `json_schema` enforces the output shape server-side; Anthropic forced
  tool-use is reliable but not server-validated (same as xAI/Gemini/Mistral here). The
  call sites already degrade gracefully on malformed JSON and `sanitizeProposals` cleans
  output, so this is not a regression — but a future tightening could validate Claude
  tool output against the schema before use.
- `summarizeOpenAiRequest` telemetry reports an Anthropic body's `systemChars` as 0
  (the system prompt is a top-level field, not a message role). Cosmetic only; the call
  still traces model/endpoint/transport correctly.
