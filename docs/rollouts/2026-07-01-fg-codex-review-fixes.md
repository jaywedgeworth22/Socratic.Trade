# 2026-07-01 — F/G PR #293 Codex-review fixes

Follow-up commit on `claude/audit-work-split-f-g-o67jj2` (PR #293) addressing 5 automated Codex
review findings (2×P1, 3×P2). Each was verified against the actual code before fixing.

## Summary / Why

1. **P1 — reindex routes lost the production token gate.** Migrating `reindex-10k`/`reindex-8k` to the
   shared `requireAdmin` regressed a defense-in-depth property: when app auth is unconfigured,
   `middleware.ts` injects the primary-operator email for **every** request, which satisfied
   `checkAdmin`'s email path and let an unauthenticated caller trigger a paid Voyage backfill in a
   prod misconfiguration (the old local `authorized()` still required the token in production).
   **Fix:** new `requireTokenInProd` option on `checkAdmin` — in production a verified admin *email*
   alone is insufficient; the `x-admin-token` must match. Both reindex routes pass it. Keeps the
   shared-gate migration + timing-safe compare; non-prod dev/ops open path preserved.

2. **P1 — live pre-flight guard missing on the approval path.** `assertLivePreflight` protected only
   the autonomous run loop; `approveProposal` reaches its own `gateway.placeEquityOrder` for
   human-approved proposals. **Fix:** wire the same default-safe guard before the approval-path
   placement (no-op in paper/test; blocks `broker/live` unless `paperMode:false` AND
   `ALLOW_LIVE_TRADING=true`). Records a `blocked` status + `order_blocked_live_preflight` audit
   (`path: "approval"`). Never places/enables a trade.

3. **P2 — cached query embeds metered as real calls.** `retrieveContextDetailed` called
   `meterEmbed([query])` unconditionally after `embedQueryCached`, so cache hits inserted phantom
   `rag_usage` rows + estimated Voyage cost — corrupting the very dashboards the cache reduces.
   **Fix:** `embedQueryCached` now returns `{ response, cached }`; meter only when `!cached`.

4. **P2 — daily LLM budget ceiling bypassed on interval runs.** The ceiling was checked only in the
   event-trigger `fire()` path; the fixed scheduler (`scheduler.ts`) calls `runStrategyOnce` directly
   in interval/both mode, spending past a configured cap. **Fix:** call `checkLlmDailyBudget` in the
   scheduler's run loop too (audit `trigger_suppressed_budget`, `path:"scheduler"`). Still default-off.

5. **P2 — OAuth-token encryption bricked the memory-only fallback.** Encrypting with db-api-keys'
   *ephemeral* key (when `ENCRYPTION_KEY` is unset) gave no real at-rest protection and, after a
   restart, decrypted to empty — and `getStoredMcpOAuthTokens` returned a dead empty token, so
   `migrateLocalRobinhoodToken()` skipped reseeding from the still-present env token. **Fix:** only
   encrypt when a stable `ENCRYPTION_KEY` is configured (else store plaintext, as before — a strict
   upgrade, never a regression); and treat an empty-decrypted `accessToken` as **missing** so env
   reseed / re-auth runs.

## Files

- `src/lib/auth/admin.ts` — `requireTokenInProd` option + gate logic.
- `app/api/admin/reindex-10k/route.ts`, `app/api/admin/reindex-8k/route.ts` — pass `requireTokenInProd: true`.
- `src/lib/strategy.ts` — `assertLivePreflight` on the `approveProposal` placement path.
- `src/lib/vector-db.ts` — `embedQueryCached` returns hit/miss; meter only on miss.
- `src/lib/scheduler.ts` — daily-budget check on the interval-run lane.
- `src/lib/mcp-oauth.ts` — gate encryption on `ENCRYPTION_KEY`; empty-decrypt → missing.
- Tests: extended `test/security-admin-timing-safe.test.ts`, `test/query-embedding-cache.test.ts`,
  `test/security-oauth-token-encryption.test.ts` (+6 cases).

## Verification

`npx tsc --noEmit` 0 errors · `npm run lint` 0 errors · `npm test` **1726/1726** · `npm run build` ok.
(Private `@jaywedgeworth22/congress-trading-shared` dep stubbed locally as before; CI `verify` uses the
real package.)

## Follow-ups

- Deferred still: the `strategy.ts` god-module split. The budget ceiling now covers both the event
  and interval autonomous lanes; manual "Run once" is intentionally not gated by the daily ceiling.
