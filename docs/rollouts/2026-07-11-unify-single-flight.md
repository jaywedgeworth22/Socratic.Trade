# Rollout: Unify Manual and Scheduler Single-Flight Locks

- **Summary**: Unified manual (admin) and background (scheduler) single-flight locks for RAG reindexing, web-source refreshes, and Congress daily share.
- **Why**: Previously, `admin-operation-guard.ts` enforced single-flight locks manually for admin routes, but background scheduler tasks lacked the same lock. This led to potential overlaps (e.g., between an admin manual trigger and a scheduler tick running concurrently). By pushing the single-flight `withInFlightGuard` lock down into the domain logic (`sec8k.ts`, `sec-filings.ts`, `congress-share.ts`, `congress.ts`), we ensure that *any* entry point (admin API, scheduler, etc.) respects the same memory lock, avoiding duplicative work and rate limit burns.
- **Files**:
  - `src/lib/in-flight.ts` (NEW)
  - `src/lib/admin-operation-guard.ts`
  - `src/lib/congress-share.ts`
  - `src/lib/web-sources/congress.ts`
  - `src/lib/web-sources/sec-filings.ts`
  - `src/lib/web-sources/sec8k.ts`
  - `src/lib/web-sources/types.ts`
  - `app/api/admin/congress-share/route.ts`
  - `app/api/admin/refresh-websource/route.ts`
  - `app/api/admin/reindex-10k/route.ts`
  - `app/api/admin/reindex-8k/route.ts`
  - `test/admin-operation-guard.test.ts`
  - `test/admin-operation-route-behavior.test.ts`
- **Verification**: Ran `npm run lint`, `npx tsc --noEmit`, `npm test` (3746 tests passed), and `npm run build`. Fixed the route tests to correctly verify the route-level 409 rejection mapping.
- **Follow-ups**: The current memory lock (`in-flight.ts`) is single-process. If the scheduler is ever moved to a separate process or server, a durable database lock (e.g., in `settings-kv`) will be required.
