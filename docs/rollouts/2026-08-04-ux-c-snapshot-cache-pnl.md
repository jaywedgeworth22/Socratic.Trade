# 2026-08-04 — UX PR-C1 + C2: snapshot TTL cache + calculatePnl once

## Context & Objective

UX improvement program Wave C speed (`docs/design/ux-improvement-program.md`):

- **PR-C1** — short in-memory TTL for `getDashboardSnapshot` so desktop poll + mobile
  snapshot share work within ~10s.
- **PR-C2** — run FIFO `calculatePnl` once per fill source when assembling the snapshot
  and thread the result into scorecards / tax / performance (same pattern as prefetched fills).

## Changes Made

### C1 — Snapshot TTL cache

- New module `src/lib/dashboard-snapshot-cache.ts`:
  - Cache key = `userId + "\0" + accountNumber + "\0" + connectedAccountId`
    (**must** include user + account identity — multi-account users never share entries).
  - Default TTL **10s** (`DASHBOARD_SNAPSHOT_TTL_MS`, clamped 1s–60s).
  - Singleflight: concurrent misses for the same key share one build promise.
  - `invalidateDashboardSnapshotCache(userId?)` drops one user (or everything).
- `getDashboardSnapshot` wraps `buildDashboardSnapshot` via the cache; `currentUser`
  display fields are re-stamped on every return so a hit never leaks another session’s
  email/name.
- Invalidation:
  - `setPolicy` (lazy import — avoids db ↔ dashboard cycle)
  - mobile `finishCommand` (approve/stop/activate/etc.)
- Short TTL is the safety net when invalidation is incomplete.

### C2 — calculatePnl once

- Exported `PnlResult`; extended `PrefetchedFills` with optional `livePnl` / `paperPnl`.
- Internal `pnlForSource(...)` prefers precomputed results; falls back to
  `calculatePnl(fillsForSource(...))` for callers that omit them.
- Scorecards, tax (`getClosedLotsDetailed` / `getOpenLots`), and
  `getPerformanceSummary` all go through `pnlForSource` / prefetched P&L.
- `buildDashboardSnapshot` computes:

  ```ts
  const livePnl = calculatePnl(liveFills, currentPrices);
  const paperPnl = calculatePnl(paperFills, currentPrices);
  const prefetchedFills = { liveFills, paperFills, livePnl, paperPnl };
  ```

  Exactly **two** `calculatePnl` calls per snapshot (one per source), not 4–5+.

### Touched files

- `src/lib/dashboard-snapshot-cache.ts` (new)
- `src/lib/dashboard.ts` — cache wrapper + prefetched P&L assembly
- `src/lib/performance.ts` — `PnlResult`, `PrefetchedFills.livePnl/paperPnl`, `pnlForSource`
- `src/lib/db-profiles.ts` — invalidate on `setPolicy`
- `src/lib/mobile-api.ts` — invalidate on command completion
- `test/dashboard-snapshot-cache-pnl.test.ts` (new)
- `docs/rollouts/2026-08-04-ux-c-snapshot-cache-pnl.md` (this file)
- `docs/rollouts/2026-08-04-ux-c-snapshot-pnl.md` (earlier short note; superseded by this)

## Decisions & Trade-offs

| Decision | Rationale |
|----------|-----------|
| Key includes `connectedAccountId` as well as `accountNumber` | Account numbers can theoretically collide across brokers; connected id is stable identity. |
| Broad per-user invalidation (all account keys) | Policy/command can change any account-scoped slice; short TTL makes broad drops cheap. |
| Separate cache module | Write paths (`db-profiles`, `mobile-api`) invalidate without importing the heavy dashboard graph (no cycle). |
| Prefetched P&L on `PrefetchedFills` (not a parallel type) | Same threading surface as fills; one bag for the request. |
| Combining unfiltered live+paper PnL by concat | Live and paper are separate books; concat is safer than one FIFO pass that could cross-match. |

## Verification State

```bash
npx tsc --noEmit                                    # clean
npx vitest run test/dashboard-snapshot-cache-pnl.test.ts test/dashboard-fill-batching.test.ts
# 7/7 passed
npx eslint src/lib/dashboard-snapshot-cache.ts src/lib/dashboard.ts src/lib/performance.ts \
  src/lib/db-profiles.ts src/lib/mobile-api.ts test/dashboard-snapshot-cache-pnl.test.ts
# 0 errors
```

Full suite + `npm run build` gated by CI `verify` on the PR (host load from parallel agents).

## Next Steps & Blockers

- Auto-merge when `verify` is green.
- PR-C3 (scan TableVirtuoso) and PR-C4 (React.memo) stay separate slices.
- Optional follow-up: invalidate on web approve/reject API routes (mobile path already covered).

## Design (summary)

```
GET /api/dashboard  ─┐
GET /api/mobile/snapshot ─┴─► getDashboardSnapshot(userId, currentUser)
                                 │
                                 ├─ key = userId|accountNumber|connectedAccountId
                                 ├─ TTL hit? → re-stamp currentUser, return
                                 ├─ in-flight? → await same promise
                                 └─ miss → buildDashboardSnapshot
                                           ├ fills once (live + paper)
                                           ├ calculatePnl once per source  ← C2
                                           ├ scorecards/tax/perf use prefetched
                                           └ cache result for ~10s            ← C1

setPolicy / mobile finishCommand → invalidateDashboardSnapshotCache(userId)
```
