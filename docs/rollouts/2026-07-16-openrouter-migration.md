# 2026-07-16 OpenRouter Migration

## Summary
Migrated the curated LLM catalog and UI representation to use OpenRouter exclusively for all models. Also introduced the GPT-5.6 Pro reasoning variants (e.g. `gpt-5.6-terra-pro`) to the catalog, exposing different reasoning effort levels for the OpenAI models.

## Why
The owner wants to use OpenRouter for all LLM calls to gain better cost reporting and easier access to reasoning models grouped by effort levels (pro vs non-pro).

## Files Changed
- `app/ui/llm-model-catalog.ts`: Updated all curated options to use `openrouter/...` prefixed values. Added GPT-5.6 Pro variants. Removed the standalone OpenRouter group since all models now run through OpenRouter.
- `app/console/lib/models.ts`: Updated `MODEL_DISPLAY_NAME` mapping to cleanly render the prefixed OpenRouter IDs. Updated `providerForModel` to parse the vendor namespace out of `openrouter/...` strings so the console can still render the correct vendor logos (OpenAI, Anthropic, Google, etc.) instead of falling back to a generic OpenRouter tile.

## Verification
- Checked that `providerForModel` extracts vendors correctly for UI rendering.
- Rebuilt `better-sqlite3` native bindings and successfully ran `npm test` and `npm run lint`.
- Validated via `npx tsc --noEmit`.

## Follow-ups
- Ensure `OPENROUTER_API_KEY` has sufficient quota to handle the combined load of all models. Legacy API keys (e.g., OpenAI, Anthropic) remain available in the UI to support any models users manually specify via the Custom string UI that don't have the `openrouter/` prefix.
