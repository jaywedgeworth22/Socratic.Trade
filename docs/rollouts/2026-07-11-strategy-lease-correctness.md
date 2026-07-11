# 2026-07-11 — Strategy lease ownership and scheduler default correctness

Branch: `codex/strategy-lease-correctness`

## Summary

- `executeProposal` now mints an invocation-unique owner token
  (`execute-<proposalId>-<uuid>`). Duplicate calls for one proposal no longer re-enter under the
  same owner or risk one invocation releasing the other's lease.
- New `strategy-lock-guard.ts` renews the five-minute account-scoped strategy lease every minute.
  A refused renewal or thrown DB error is caught inside the timer, recorded as sticky ownership
  loss, and never escapes as an uncaught interval error.
- Both the autonomous run loop and approval execution synchronously re-prove ownership at the final
  safe boundary before writing a `placing` intent and calling `placeEquityOrder`. The autonomous
  loop also checks at the start of each proposal and immediately after broker health, tradability,
  initial review, and bump re-review awaits. Non-placement blocked/proposed state is therefore not
  written by an invocation that lost ownership during broker I/O. Once ownership is lost, the
  invocation cannot continue into another broker placement.
- All post-acquire setup is inside the cleanup scope. If the strategy-run receipt insert throws,
  the heartbeat stops and the owner token is released instead of being renewed indefinitely.
- Approval ownership loss returns a typed `busy` result, leaves the proposal pending, and never calls
  the broker. An autonomous run that loses ownership after earlier proposal work preserves those
  completed proposal results in its failed receipt rather than returning an empty list.
- Removed obsolete teardown calls from account-deletion preparation and the usage-budget skip. They
  did not carry the actual owner token (and the skip already runs through the authoritative
  `finally` release).
- `SCHEDULER_SINGLE_LEADER` is default-on for unset, empty, and whitespace-only values. Explicit
  `false`, `off`, `0`, or `no` values still disable it for diagnostics; unrecognized values fail
  safe to enabled.
- The scheduler liveness heartbeat now runs only after a successful leader claim. A direct follower
  regression proves an idle process cannot keep `scheduler:lastTick` fresh while the leader is dead.
- Current-main reconciliation removed the obsolete `heartbeatTimer` cleanup accidentally carried by
  the newly merged broker-health early return; the guard's `finally` is the single stop/release owner.

## Why

The strategy lock already stored an owner and expiry, but approval used the deterministic owner
`execute-<proposalId>`. Two simultaneous approvals of the same card therefore looked like one
re-entrant owner; either caller could release the shared lease while the other still evaluated or
placed. Separately, the heartbeat ignored a `false` renew and let a thrown renew escape its interval,
so an invocation could continue toward the broker after it no longer owned the lease. An empty
single-leader env value also accidentally disabled scheduler coordination despite the intended
default-on posture.

## Files

- `src/lib/strategy-lock-guard.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/account-deletion.ts`
- `src/lib/scheduler.ts`
- `src/lib/scheduler-lease.ts`
- `test/strategy-lock-guard.test.ts`
- `test/strategy-lock-loss-integration.test.ts`
- `test/scheduler-single-leader-default.test.ts`
- `test/scheduler-leader-heartbeat.test.ts`
- `.env.example`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/ops-observability-security.md`
- `docs/improvement-program-2026-06-26.md`
- `docs/settings-navigation-redesign/appendix-B-capability-inventory.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-26-scheduler-lease.md`
- `docs/rollouts/2026-07-11-strategy-lease-correctness.md`

## Verification

- `npm ci --no-audit --no-fund` — installed the locked 767-package dependency set in the isolated
  worktree. It initially ran under the host's Node 26.
- First Node 24 focused run failed only because `better-sqlite3` had been installed for Node 26
  (`NODE_MODULE_VERSION 147` vs required `137`).
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm rebuild better-sqlite3` — rebuilt the native module
  for the repo's Node 24 runtime.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/strategy-lock-guard.test.ts test/scheduler-single-leader-default.test.ts test/approval-lock.test.ts test/account-deletion.test.ts test/account-delete-cleanup.test.ts test/usage-budget-strategy-integration.test.ts`
  — **6 files / 34 tests passed**.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/lib/strategy-lock-guard.ts src/lib/strategy.ts src/lib/strategy-execution.ts src/lib/account-deletion.ts src/lib/scheduler.ts src/lib/scheduler-lease.ts test/strategy-lock-guard.test.ts test/scheduler-single-leader-default.test.ts`
  — **0 errors / 35 pre-existing warnings** in the large split strategy modules.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — **clean**. It completed slowly while
  another isolated worktree was also typechecking; no diagnostic was emitted. This ran before the
  final parser tightening from truthy-list to explicit-false-list semantics; that final same-type
  expression was covered by the 11-case scheduler test and scoped ESLint, while the parent owns the
  serialized final-tree gate.
- Final current-tree rerun of the six focused files — **6 files / 34 tests passed**. A scoped rerun
  of `test/scheduler-single-leader-default.test.ts` was **11/11**, and ESLint on the parser/test was
  **0 errors / 1 inherited scheduler warning**.
- Adversarial-review regression slice:
  `test/strategy-lock-guard.test.ts`, `test/strategy-lock-loss-integration.test.ts`,
  `test/scheduler-single-leader-default.test.ts`, and `test/approval-lock.test.ts` — **4 files /
  22 tests passed**. It forces the initial run insert to throw and proves lock reacquisition, and
  forces approval ownership loss immediately before placement and proves typed busy/pending/no broker
  call behavior.
- Post-review `npx tsc --noEmit` — **clean**. Scoped ESLint across touched runtime/test files —
  **0 errors / 35 inherited warnings**. `git diff --check` — **clean**.
- Current `origin/main@e395e65a` merged cleanly. Final ordered Node 24 gate:
  focused **7 files / 36 tests**, `npm run lint` **0 errors / 404 inherited warnings**,
  `npx tsc --noEmit` clean, `npm test` **334 files / 3,764 tests**, and `npm run build` green.
- The first production build caught an import trace from `strategy-lock-guard.ts` through
  `node:crypto`, which webpack does not handle in the client-reachable scheduler graph. The UUID
  helper now uses `globalThis.crypto.randomUUID()` and adds no client bundle dependency. After that
  fix, focused **3 files / 11 tests**, TypeScript, scoped ESLint, the full **3,764-test** suite, and
  the production build all reran green.
- Review autofix `9d2ba1fb` was pushed by `github-actions[bot]`; gitleaks, hosted verify, and smoke
  correctly refused that untrusted actor. No CI trust policy was changed. A human-authored follow-up
  merged current `origin/main`; trusted runtime/test reconciliation commit `b19650ac` owns the
  corrected code. A later human merge brought the branch through `main@7c01f87e` (Alpha health lane)
  without runtime conflicts.
- The first scoped rerun used the shell's Node 26 and failed only on the expected native SQLite ABI
  mismatch (`NODE_MODULE_VERSION 147` vs the worktree's 137 build). The committed source was not
  implicated. `npm ci --no-audit --no-fund` under Node 24 refreshed the exact locked shared-v1.5
  dependency after current-main reconciliation.
- Before that refresh, `npx tsc --noEmit` found only the stale installed shared-v1.4 exports; after
  the locked install, TypeScript completed cleanly.
- `PATH=/opt/homebrew/Cellar/node@24/24.18.0/bin:$PATH npx vitest run test/strategy-lock-guard.test.ts test/strategy-lock-loss-integration.test.ts test/scheduler-single-leader-default.test.ts test/scheduler-leader-heartbeat.test.ts`
  — **4 files / 21 tests passed**.
- Touched ESLint on `strategy.ts`, `scheduler.ts`, and the four lease/scheduler regression files —
  **0 errors / 33 inherited warnings**. `npx tsc --noEmit` — **clean**. `git diff --check` — **clean**.

## Follow-ups and boundaries

- Ready PR #1429 remains open. The serialized final full test/build gate, final push, hosted checks,
  merge, and production verification remain; the prior full gate predates the review changes.
- No scheduler provider-boundary locking, production environment/configuration, PR, merge,
  deployment, or live runtime mutation is part of this change. The branch-neutral live effort board
  was updated with implementation and review receipts.
- Current-main reconciliation and the full ordered gate are complete. Hosted checks and production
  verification remain contingent on the ready PR landing through the normal auto-deploy path.

---

## Second autofix round — Codex review round 2 (2026-07-11)

The second Codex review (commit `996d0f4cb8`, submitted 19:16 UTC) raised two P2 threads that were
not covered by the first autofix round (`9d2ba1fb`).

### Thread 3 — Re-check approval lock before non-placement writes

**File:** `src/lib/strategy-execution.ts`

**Finding:** In `executeProposal`, after the awaited portfolio/positions/orders reads, market scan,
protective exit reprice, tradability check, broker review, and broker-minimum bump, each
non-placement return path (tradability blocked, broker-minimum blocked, policy-decision blocked,
held-exit blocked, live-preflight blocked, and wash-re-escalation re-queue) writes proposal status
and/or sends notifications without re-proving lease ownership. Only the placement path (line 523)
had `lockGuard.assertOwned()`. A lease failure during the preceding ~240 lines of async I/O could
let these writes execute under a stolen lease.

**Fix:** Added `lockGuard.assertOwned()` at line 205, immediately after all async setup work
(protective exit reprice) and before the first non-placement write path (tradability). This single
check protects all downstream non-placement writes. The existing placement-path check at line 523
is unchanged.

### Thread 4 — Re-check ownership after run setup awaits

**File:** `src/lib/strategy.ts`

**Finding:** In `runStrategyOnce`, the only early ownership check is at line 342 (after broker health
check). From that point through the next `assertOwned()` at line 1870 (start of the proposal loop),
~57 lines of awaited I/O execute: fill reconciliation (line 432), stale-intent recovery (line 435),
portfolio/positions/orders (lines 436–441), market scan (lines 461–468), stale-limit notification
(line 489), and then the first DB mutations: portfolio snapshot (line 494), drawdown breaker
systemState changes (lines 529–530), and volatility brake systemState changes (lines 560). A lease
failure during any of those awaits would let snapshot records and systemState changes execute under
a stolen lease.

**Fix:** Added `lockGuard.assertOwned()` at line 492, immediately after all async setup work and
before the first DB mutation in the protected region (portfolio snapshot).

### Verification

- `npx tsc --noEmit` — clean
- `npm test` — 336 files / 3768 tests passed
- `npm run build` — clean
- Both review threads resolved via GraphQL API
- Auto-merge enabled on PR #1429
- Commit: `3bfd312` — `[codex-autofix] Re-check ownership before non-placement writes and after strategy run setup awaits`
