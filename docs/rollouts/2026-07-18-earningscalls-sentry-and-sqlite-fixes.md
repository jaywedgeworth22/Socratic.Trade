# Rollout Note: Earningscalls Sentry Suppression & SQLite busy_timeout Upgrade

## Summary
This rollout resolves recurrent Sentry connection-failure noise from the dormant `earningscalls` transcript integration, and protects SQLite transactions from timing out under heavy disk/CPU thrashing during Docker builds.

## Rationale & Decision
1. **Earningscalls Sentry Spam**:
   - The `earningscalls` service is currently inactive in production (no active RapidAPI subscription, yielding `HTTP 401 Unauthorized` or `HTTP 403 Forbidden`).
   - Because `keySource` was unconfigured, it defaulted to `"none"`, triggering Immediate Sentry connection-failed alerts via `api_health_log`.
   - Adding `401` and `403` to `suppressHealthStatuses` and setting `keySource: "env"` suppresses these alerts, leaving the service dormant without spamming the operator.
2. **SQLite busy_timeout**:
   - Spikes in disk write latency (typically during concurrent Next.js Next/Webpack compiles inside Coolify on the Hetzner box) caused database write locks to exceed the default `5000ms` `busy_timeout`.
   - Increasing this to `30000ms` (30 seconds) allows SQLite transactions to wait out transient disk thrashes instead of failing immediately with `SqliteError: database is locked`.

## Files Modified
- [src/lib/db.ts](file:///Users/jay/apps/trading-antigravity/src/lib/db.ts) — Increased SQLite `busy_timeout` to 30000.
- [src/lib/earningscalls-transcripts.ts](file:///Users/jay/apps/trading-antigravity/src/lib/earningscalls-transcripts.ts) — Added `keySource: "env"` and `401, 403` to `suppressHealthStatuses`.

## Verification Details
- Built project under Node 24: `npx tsc --noEmit` is clean.
- Unit tests run under Node 24:
  - `test/earningscalls-transcripts.test.ts` (32/32 passing).
  - `test/persistence-notification.test.ts` (19/19 passing).
