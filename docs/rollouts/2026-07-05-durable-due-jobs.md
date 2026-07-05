# 2026-07-05 - durable-due-jobs

## Summary

Adds a durable, generic claimable due-jobs substrate (`due_jobs` table + `src/lib/db-jobs.ts`) so
15m/1h intraday outcome-horizon sampling survives process downtime instead of depending on a
strategy run coincidentally landing inside the narrow sampling window. Wires it into the two
places a decision case / skipped-candidate counterfactual establishes an entry basis
(`counterfactual-learning.ts`'s `insertSkippedCounterfactualCandidate` insert sites, and
`outcome-engine.ts`'s `measureCase` once a placed/blocked/rejected case's fill or ref-price basis
resolves), adds a new worker (`drainDueIntradaySampleJobs`) that drains due jobs by sampling a
live quote and writing through the exact same merge/write path the existing inline
`samplableNow` sampling path uses, and adds one fire-and-forget drain call to `scheduler.ts`'s
`tick()`. The existing inline path is left fully intact — this is belt-and-suspenders, not a
replacement.

## Why

`src/lib/outcome-horizons.ts:22-29` documented the gap explicitly: intraday horizons are
resolvable only by sampling a live quote while the tolerance window is open, and no substrate
guaranteed that sampling would ever be attempted except by accident (a strategy run's cadence
happening to fall inside a 15m-45m or 1h-2h window after a fill/ref-price snapshot).
`matureSocraticDecisionOutcomes` (the only caller of the intraday sampling logic) runs only
piggybacked inside `runStrategyOnce` (`strategy.ts:1420-1428`); `counterfactual-learning.ts`
shares the same gap. The existing `mobile_commands` queue (migration v8, `mobile-api.ts`) is the
closest precedent for a durable job queue in this codebase, but it has no lease/reclaim: a
crashed `running` row is stuck forever. This substrate explicitly avoids copying that gap by
adding `claimed_by` + `lease_expires_at` with atomic stale-lease reclaim, following the CAS idiom
already used by `acquireStrategyLock` (`db-execution.ts`) and the scheduler lease
(`scheduler-lease.ts`).

### Design decisions

- **New migration (v11) rather than an unversioned `migrate()` addition** — `due_jobs` is a brand
  new table with no legacy-data backfill concern, so it goes in the versioned `MIGRATIONS` array
  (the pattern `db.ts`'s own comments say to prefer for new schema changes going forward), not the
  baseline `migrate()` exec block.
- **Enqueue-at-basis-establishment, not enqueue-at-case-creation.** For a "placed" decision case,
  the entry basis is the FILL price/time, which is not known at `upsertSocraticDecisionCase` time
  (fills land later via async broker reconciliation) — enqueueing there would either fabricate a
  basis or require a second wiring point. Instead, jobs are enqueued from `outcome-engine.ts`'s
  `measureCase`, the one place in the codebase that already resolves `basisPrice`/`basisAtMs`
  honestly for every case shape (placed-with-fill, blocked/rejected-with-counterfactual,
  blocked/rejected-with-daily-close-fallback). For skipped-candidate counterfactuals, the basis
  (`refPrice` + `snapshotAt`) IS known immediately at insert time, so those are enqueued straight
  from `counterfactual-learning.ts`'s two insert call sites
  (`recordRejectedProposalCounterfactual`, `ingestSignalSnapshot`).
- **Idempotent by construction, not by caller discipline.** `enqueueDueJob` is `INSERT OR IGNORE`
  on `UNIQUE(job_type, dedupe_key)`, with `dedupe_key = "<caseKind>:<caseId>:<horizon>"`. This
  means `measureCase` can safely call the enqueue helper on every pass for a case (it does) without
  ever creating a duplicate row, and a case re-established (e.g. after a schema oddity) can't fork
  into two competing jobs for the same horizon.
- **No duplicate horizon rows when both the inline path and the worker fire.** `mergeHorizonRows`
  already had "existing terminal row wins" semantics; its doc comment was strengthened to say
  explicitly which side wins when both the inline `samplableNow` sampling in `measureCase` and the
  due-jobs worker race for the same horizon: whichever WRITES (persists) first wins, and the other
  reads that persisted row as already-terminal via a fresh DB read (`readExistingOutcomes`) and
  short-circuits with an `"already_resolved"` job-complete, never re-pricing or overwriting.
- **Counterfactual outcome rows need a new low-level writer.** The existing
  `markSkippedCounterfactualMatured` / `markSkippedCounterfactualUnresolvable` writers require an
  exit bar / terminal reason the due-jobs worker doesn't have — sampling one intraday horizon
  doesn't close the whole counterfactual. Added `updateSkippedCounterfactualOutcomes` (db-learning.ts),
  gated the same way (`status = 'pending'`) so it's a harmless no-op once the row has gone terminal.
- **Fire-safe enqueues.** Both enqueue call sites wrap `buildIntradaySampleJobSpecs` +
  `enqueueDueJob` in try/catch with a `console.warn` — a due-jobs failure can never break the
  counterfactual/decision-case pipelines that call it.
- **Retry/backoff semantics in `failDueJob`.** A failed claimed job returns to `pending` with
  `due_at` pushed out by `retryBackoffMs` (default 10 minutes) unless `attempts >= maxAttempts`
  (default 5) or the job is already past its `not_after` deadline, either of which makes it
  terminally `unresolvable` — mirroring the "kill-survivorship" convention the rest of the outcome
  engine already uses (never left pending forever, always countable).

## Files

- `src/lib/db.ts` — new migration v11 (`due_jobs` table + indexes); barrel re-export of
  `db-jobs.ts`.
- `src/lib/db-jobs.ts` (new) — `enqueueDueJob`, `claimDueJobs`, `completeDueJob`, `failDueJob`,
  `markDueJobUnresolvable`, `getDueJobStats`.
- `src/lib/outcome-horizons.ts` — `buildIntradaySampleJobSpecs` (pure spec builder, no I/O);
  strengthened `mergeHorizonRows` doc comment to document which side wins on a race.
- `src/lib/outcome-engine.ts` — `measureCase` now enqueues intraday sample jobs once a case's
  basis resolves; new `drainDueIntradaySampleJobs` worker + its helpers
  (`enqueueIntradayDecisionSampleJobs`, `parseIntradaySampleJobPayload`, `readExistingOutcomes`,
  `writeIntradaySampleRow`).
- `src/lib/counterfactual-learning.ts` — `enqueueIntradaySampleJobs` helper called from
  `recordRejectedProposalCounterfactual` and `ingestSignalSnapshot` after a successful insert.
- `src/lib/db-learning.ts` — `skippedCounterfactualId` (single-sourced id format, exported so
  callers can derive it without a re-read) and `updateSkippedCounterfactualOutcomes` (new
  low-level, pending-gated outcome writer for the intraday worker).
- `src/lib/scheduler.ts` — one fire-and-forget `drainDueIntradaySampleJobs()` call in `tick()`,
  next to the existing `processPendingMobileCommands` call.
- `test/db-jobs.test.ts` (new) — 10 tests covering the queue mechanics.
- `test/outcome-engine-due-jobs.test.ts` (new) — 5 tests covering the enqueue + worker + no-dup
  integration.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md` — updated per the
  handoff protocol.

## Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/db-jobs.test.ts test/outcome-engine-due-jobs.test.ts` — 15/15 passed.
- `npx vitest run test/db-jobs.test.ts test/outcome-engine-due-jobs.test.ts test/outcome-engine.test.ts test/counterfactual-learning.test.ts test/rejected-counterfactual.test.ts test/performance.test.ts test/per-account-policy-isolation.test.ts` —
  72/72 passed (confirms no regression in the pipelines this change touches).
- `npx vitest run test/db-migration-old-schema.test.ts test/scheduler-lease.test.ts test/scheduler-cadence.test.ts test/persistence-hardening.test.ts test/socratic-db.test.ts test/socratic-memory.test.ts test/socratic-runtime.test.ts` —
  28/28 passed (migration framework + scheduler + Socratic case-file paths unaffected).
- Full `npm test` and `npm run build` were **not** run in this worktree per this branch's
  operating rules (the central landing operator runs those before merge).

## Follow-ups

- The due-jobs table is intentionally generic (`job_type` column), not intraday-sampling-specific —
  a future job type (e.g. a deferred notification retry, or a scheduled re-check) can reuse
  `db-jobs.ts` without another migration.
- `drainDueIntradaySampleJobs` claims globally across all users (like the real scheduler tick,
  and like `processPendingMobileCommands`) rather than per-user — this matches the existing
  single-process scheduler model in this codebase and was validated in tests by asserting on the
  specific case's row rather than aggregate drain counts (multiple tests' due-jobs coexist in the
  same DB `due_jobs` table by design, since `claimDueJobs` has no user-scoping and shouldn't need
  one at this stage).
- No admin/ops UI surfaces `getDueJobStats` yet; it's available for a future receipts/ops-snapshot
  addition but isn't wired into `/api/ops/snapshot` in this change (out of scope — this lane owns
  the substrate + outcome-engine wiring only, per the task's KEEPOUT on `app/console/**`).
- `updateSkippedCounterfactualOutcomes`'s pending-only guard means an intraday sample that arrives
  AFTER the counterfactual has already gone terminal (matured/unresolvable) is a silent no-op by
  design (the terminal row's `outcomes` are owned by whichever writer closed it) — this mirrors the
  existing `markSkippedCounterfactualChecked`/`markSkippedCounterfactualMatured` gating and was not
  treated as a bug to fix in this pass.
