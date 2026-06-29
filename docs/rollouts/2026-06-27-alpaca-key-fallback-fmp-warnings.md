# Rollout Note: Alpaca API Key Fallback Resolution & FMP Warnings Fix

## Summary
- Checked the `/admin/connections` health status page and diagnosed completeness of instrumented sources.
- Fixed `resolveAlpacaMarketData` to fallback to decrypting valid credentials from the user's `connected_accounts` table, resolving persistent `HTTP 401` auth errors on the `alpaca-news` and `alpaca-snapshot` data enrichment providers.
- Fixed `FmpEnrichmentProvider` to disable health logging on optional/premium endpoints (`insider-trading`, `senate-trading`, `price-target-consensus`) returning `HTTP 403` on standard plans, preventing false-positive yellow warning dots on the dashboard.

## Why
- **Completeness:** The health page dynamically lists services based on the `api_health_log` table, meaning uncalled or uninstrumented services (like FRED, SEC XBRL scraper, and Alpaca execution) are naturally omitted.
- **Alpaca 401s:** Stored keys in `user_api_keys` (migrated from env) were invalid/expired, whereas correct keys existed in `connected_accounts`.
- **FMP Yellow Dot:** Premium endpoints were unconditionally called and written as service failures on standard subscription tiers.

## Files
- **Touch**: [src/lib/db-api-keys.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/debug-source-connection-status/src/lib/db-api-keys.ts) (modified `resolveAlpacaMarketData` key lookup hierarchy)
- **Touch**: [src/lib/data-providers.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/debug-source-connection-status/src/lib/data-providers.ts) (modified FMP `getJson` signature and disabled health logging on premium queries)
- **Touch**: [test/key-resolution-tiering.test.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/debug-source-connection-status/test/key-resolution-tiering.test.ts) (added tests verifying connected accounts credentials resolution and preference)

## Verification
The following commands were run in the worktree root:
1. `npx tsc --noEmit` - passed cleanly
2. `npm test` - all 1255 tests passed cleanly (including the new credential-resolution tests)
3. `npm run build` - compiled Next.js output and generated static/dynamic routing without errors
