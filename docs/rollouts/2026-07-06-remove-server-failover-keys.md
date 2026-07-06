# 2026-07-06 Remove server failover API keys

## Summary
The system has been decoupled from operator-funded server-side API keys (`process.env` fallbacks) for LLMs and related services. All LLM and service calls are now authenticated exclusively via database-backed per-user API keys (`user_api_keys` table). The first user (the owner) will configure their keys, which automatically work system-wide for their account and data sharing.

## Why
The user requested the elimination of server failover API keys for LLMs. This ensures a clean per-user credential model and removes reliance on `process.env` fallbacks.

## Files
- `src/lib/db-api-keys.ts`
- `src/lib/llm-usage.ts`
- `test/key-resolution-tiering.test.ts`
- `test/settings.test.ts`
- `test/db-api-keys.test.ts`
- (Multiple other `test/*.test.ts` files updated to replace `process.env` stubs with `upsertUserApiKey` database records)

## Verification
- Ran the automated refactor script to update test files.
- `npm test`: 2836/2836 tests passed.
- `npx tsc --noEmit`: Clean.
- `npm run build`: Successful build.
- `npm run lint`: Clean.

## Follow-ups
- Proceed with merging to `main` and deploying to production via the standard workflow (`scripts/land.sh` or PR creation).
