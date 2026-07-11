# Runtime Release and Backup Health

Date: 2026-07-11
Owner: CODEX
Branch: `codex/runtime-release-backup-health`
PR: <https://github.com/jaywedgeworth22/Socratic.Trade/pull/1405> (ready, not merged)

## Summary

- Add a public-safe runtime identity to `/api/health`: validated source commit, process start time,
  and uptime.
- Explicitly enable Litestream 0.5.12's production control socket and query it with a hard
  wall-clock deadline, 64 KiB response cap, and response abort/error/early-close handling.
- Report the configured database's daemon status, last successful sync, age, and signal source.
- Correct the v0.5.x hidden metadata fallback path (`.app.db-litestream`). Production skips that
  synchronous file scan entirely because local activity cannot certify an R2 upload; non-live scans
  are diagnostic-only and strictly bounded by entry count and depth.
- Use pure, tested live-mode assessment logic. Degrade unavailable, stopped, invalid-timestamp,
  never-successfully-synced, and genuinely lagging states; allow five minutes after process start for
  the first upload, and do not call an idle caught-up database stale merely because no new sync ran.

## Why

The health payload could not identify the running release and normally returned no actionable
Litestream freshness signal. That made it difficult to distinguish merged code from the actually
running revision or confirm that the declared SQLite recovery path was active. Litestream 0.5.12
supports a read-only local `GET /list` IPC endpoint at `/var/run/litestream.sock`; it returns database
status and `last_sync_at` without contacting or mutating the replica.

Adversarial review found three operational-truth gaps in the initial implementation: v0.5.12 leaves
the socket disabled unless configured; its default metadata directory is hidden; and a
`status: replicating` response can omit `last_sync_at` until the first successful remote upload. The
final implementation handles those cases explicitly. A second adversarial pass also caught that the
file fallback could defeat the IPC deadline through an unbounded synchronous traversal, that an idle
database can legitimately retain an old last-sync time, and that a future timestamp could appear
fresh. Production now skips the file traversal; non-live traversal is bounded; staleness requires
local DB/WAL activity newer than the last successful sync; materially future timestamps degrade. The
client also does not use Node's inactivity-only `ClientRequest#setTimeout()` as an end-to-end deadline.

References:

- <https://github.com/benbjohnson/litestream/blob/v0.5.12/server.go#L24-L30>
- <https://github.com/benbjohnson/litestream/blob/v0.5.12/cmd/litestream/replicate.go#L300-L310>
- <https://github.com/benbjohnson/litestream/blob/v0.5.12/db.go#L269-L276>
- <https://github.com/benbjohnson/litestream/blob/v0.5.12/server.go#L486-L507>
- <https://coolify.io/docs/knowledge-base/environment-variables>

## Files

- `app/api/health/route.ts`
- `litestream.coolify.yml`
- `src/lib/runtime-health.ts`
- `test/runtime-health.test.ts`
- `test/connection-health-routing.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-11-runtime-release-backup-health.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral coordination board)

## Verification

Completed lightweight checks:

```bash
git diff --check
# passed

node --experimental-strip-types --check src/lib/runtime-health.ts
node --experimental-strip-types --check app/api/health/route.ts
node --experimental-strip-types --check test/runtime-health.test.ts
# passed

node --experimental-strip-types --input-type=module -e '<pure assessment/path assertions>'
# runtime-health pure smoke: ok

node --experimental-strip-types --input-type=module -e '<Unix-socket deadline/body-cap assertions>'
# runtime-health transport smoke: ok

npx vitest run test/runtime-health.test.ts test/connection-health-routing.test.ts
# 2 files, 26 tests passed

npx eslint app/api/health/route.ts src/lib/runtime-health.ts test/runtime-health.test.ts test/connection-health-routing.test.ts
# 0 errors, 2 pre-existing no-explicit-any warnings in connection-health-routing.test.ts

npx tsc --noEmit
# passed
```

The initial focused attempt was blocked because this isolated worktree's interrupted install had no
test binaries. Node 24 dependencies were then cloned from a clean isolated worktree after the prior
gate cleared, and the focused suite/typecheck passed. The first Unix-socket test run exposed Darwin's
short socket-path limit under Vitest's nested managed TMPDIR; tests now bind a relative socket name
while keeping the artifact inside that per-run temp directory. The complete Node 24 gate passed:

```bash
npm run lint
# passed: 0 errors, 378 existing warnings

npx tsc --noEmit
# passed

npm test
# passed: 319 files, 3,509 tests

npm run build
# passed (pre-existing Sentry Edge-runtime warning only)
```

After PR creation, `origin/main` advanced with #1397. The branch merged that commit cleanly; the
landing workflow re-runs lint plus the post-merge TypeScript/full-test/build gate before refreshing
PR #1405. No merge, auto-merge, deploy, or live health mutation is part of this work.

The first post-merge landing attempt ran lint cleanly (0 errors, 406 existing warnings), then
TypeScript reported missing `ts-morph` types because this worktree's cloned `node_modules` predated
#1397's new lockfile dependency. This is a dependency-install state mismatch, not a source failure;
refresh with Node 24 `npm ci`, then rerun the complete landing gate.

## Follow-ups

- After merge/auto-deploy, confirm `/api/health` reports the deployed `SOURCE_COMMIT`,
  `litestreamSource: "ipc"`, `litestreamDegradedReasons: []`, a replicating daemon state, and a
  recent non-null sync timestamp. Also confirm the socket exists with mode 0600 inside the container.
- The operations snapshot still uses its older synchronous file scan; unify it with this helper only
  if that route is converted to an async snapshot builder in a separately coordinated change.
- `alertStorageWarning()` records its 12-hour cooldown before notification delivery succeeds. This
  pre-existing reliability issue was intentionally left out of scope; fix it separately so a failed
  delivery remains retryable without weakening deduplication.
