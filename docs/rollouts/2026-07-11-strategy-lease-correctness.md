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
  loop also checks at the start of each proposal. Once ownership is lost, the invocation cannot
  continue into another broker placement.
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

## Follow-ups and boundaries

- Head `f70e9043` is pushed in ready PR #1429; hosted checks/review and production verification remain.
- No scheduler provider-boundary locking, production environment/configuration, PR, merge,
  deployment, or live runtime mutation is part of this change. The branch-neutral live effort board
  was updated with implementation and review receipts.
- Current-main reconciliation and the full ordered gate are complete. Hosted checks and production
  verification remain contingent on the ready PR landing through the normal auto-deploy path.
