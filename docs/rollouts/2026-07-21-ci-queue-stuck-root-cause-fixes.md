# 2026-07-21 -- ST PR queue stuck for days: root causes and fixes

## Diagnosis (live)

1. **Cancel thrash (primary for "days of red checks")**
   - `ci.yml` concurrency `cancel-in-progress: true` cancels in-flight `verify` whenever
     a new push hits the same branch.
   - Sample of last 20 CI runs: **18 cancelled**, 0 successful on recent PR heads.
   - Multi-agent fleet keeps pushing/merging main into PR branches faster than a ~15-20 min
     verify can finish on the self-hosted pool.

2. **Offline `trading-live` Mac (primary for stuck gitleaks / pin-check / smoke)**
   - GitHub runners list: only Coolify `socratic-ci` / `socratic-ci-2` / `socratic-deploy` online.
   - **No `trading-live` runner online.**
   - Workflows still scheduled on `[self-hosted, trading-live]`: Security/gitleaks, shared-package
     pin check, Playwright Smoke, Codex Autofix, Sentry reporting, effort sync, cache cleanup,
     merge-shepherd, and CI `verify-self` (normally skipped by its stale-publisher guard).
   - Result: **21+ pin-check jobs queued forever**, gitleaks never completes, smoke pile-up.
   - The active ruleset requires only `verify`; these optional jobs do not independently block a
     merge, but they create never-finishing runs, hide useful failures, and make queue diagnosis
     unreliable.

3. **Smoke-on-every-PR load (secondary)**
   - Playwright Smoke was not ruleset-required but still fired on every PR and competed for
     capacity (and was pinned to offline trading-live).

4. **Per-PR blockers are real but not the systemic queue cause**
   - The full sweep found every original open head conflict-free at audit time, but required
     conversation resolution still blocks #1856, #1855, #1845, #1844, #1840, #1777, #1776, and
     #1775. Those findings are being repaired and landed separately after this dependency.

5. **Current-main test drift (hidden until a verification survived long enough to run)**
   - Six assertions on `main` no longer matched intentional production behavior: Yahoo retry tests
     used the global configured cascade, the bare-policy fixture retained the new short-stop default,
     lesson indexing added a second valid dedup prefix, and two budget-gated runs now truthfully
     report `skipped` instead of `completed`.
   - The fixes existed as an otherwise-unlanded commit on the #1856 lineage; this PR applies the
     same scoped corrections so its first durable verification can complete.

6. **Whole runner-service restart during the first durable run**
   - #1857's first `verify-hosted` reached the test suite, then was cancelled at
     `2026-07-22T02:08:07Z` when all seven applications in the shared Coolify `github-runner`
     service updated and re-registered simultaneously.
   - Runner self-update is disabled and `EPHEMERAL=false`; the restart was an external service
     mutation. A fleet-wide hold now prohibits runner-service restarts during the merge drain.

## Fixes in this change

| File | Change |
|------|--------|
| `ci.yml` | set `cancel-in-progress: false`, preserving the running verification while GitHub retains only the newest pending head |
| `security.yml` | gitleaks `trading-live` -> `socratic-ci` |
| `shared-package-pin-check.yml` | pin check `trading-live` -> `socratic-ci` |
| `e2e.yml` | remove `pull_request`/`merge_group` triggers (smoke on main/nightly/manual only); runners -> `socratic-ci` |
| `codex-autofix.yml`, `effort-issues-sync.yml`, `cleanup-caches.yml`, `_merge-shepherd-impl.yml`, `ci.yml` | remove every remaining workflow job target for the retired `trading-live` runner |
| `sentry-ci-report.yml`, `scripts/sentry-ci-report.py` | use the separate `socratic-deploy` observer lane and keep the Sentry monitor mirror aligned with the new nightly smoke cron |
| `test/ci-workflow-queue-safety.test.ts` | prevent cancellation, dead-runner routing, and smoke-on-PR regressions |
| `src/lib/data-providers.ts`, five existing test files | isolate Yahoo retry tests and align stale assertions with current short-stop, lesson-index, and budget-status behavior |
| `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md` | record the actual runner and queue-recovery plan instead of the superseded hosted-runner proposal |

## Ops follow-ups (not in this PR)

- Avoid unnecessary ST branch pushes while `verify` is in progress; the workflow now protects the
  active run and collapses intermediate pending heads, but excess pushes still consume a later slot.
- Prefer exclusive serial merge train: 1-2 PRs at a time until queue < 10.
- Keep the two `socratic-ci` containers for PR-controlled code; keep `socratic-deploy` isolated for
  trusted failure reporting rather than admitting it through generic Linux labels.
- Land remaining queue via auto-merge once verify+gitleaks go green without cancel.

## Verification

- `npm run lint` — passed with 0 errors and 597 inherited warnings.
- `npx tsc --noEmit` — passed.
- `npx vitest run --maxWorkers=1 test/ci-workflow-queue-safety.test.ts test/sentry-ci-report-workflows.test.ts`
  — 2 files, 6 tests passed.
- The exact pre-existing assertion-fix set was independently run on the #1856 lineage:
  `npx vitest run test/data-providers.test.ts test/policy.test.ts test/outcome-engine.test.ts test/usage-budget-strategy-integration.test.ts test/strategy-money-path-f-g.test.ts`
  — 5 files, 184 tests passed.
- A concurrent local `npm test` run was stopped after extreme host contention produced unrelated
  timeouts and after it exposed the six now-corrected stale assertions. The required hosted
  `verify` remains the full-suite/build merge authority; auto-merge cannot bypass it.
- `gh api repos/.../actions/runners` — both `socratic-ci` runners and `socratic-deploy` online.
- After merge+deploy of workflows: new gitleaks/pin/autofix jobs should run on `socratic-ci`, and
  Sentry CI reporting should run on `socratic-deploy`.
- Cancel obsolete queued runs that were created before the label fix and still wait on
  `trading-live`; they cannot be rescued by a workflow edit after dispatch.
