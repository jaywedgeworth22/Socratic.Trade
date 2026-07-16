# 2026-07-16 — OpenRouter Migration Completed

## Summary
Completed the migration of all LLM API calls to OpenRouter. Updated the catalog, model rotation pool, test suites, and reasoning recommendations to use the `openrouter/` prefixed model IDs. This enables unified access, cost reporting, and the addition of specific reasoning tier models ("-pro" variants) through OpenRouter.

## Why
The user requested routing all LLM calls through OpenRouter for better control, consolidated cost reporting, and the ability to leverage OpenRouter's reasoning-level variants (e.g., `gpt-5.6-terra-pro` for deeper analysis vs `gpt-5.6-terra`).

## Files Touched
- `src/lib/llm-request.ts`
- `src/lib/model-rotation.ts`
- `src/lib/model-reasoning-recommendations.ts`
- `app/ui/llm-model-catalog.ts`
- `test/model-rotation.test.ts`
- `test/openai-model-catalog.test.ts`

## Verification
Ran all vitest suites, resolving final assertions for `model-rotation.test.ts` and `openai-model-catalog.test.ts`.

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" npx vitest run test/model-rotation.test.ts test/openai-model-catalog.test.ts
```

## Follow-ups
None for this specific migration. Future work may evaluate actual spend against the Pro tiers to refine recommendation defaults.
