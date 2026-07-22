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
   - Workflows still scheduled on `[self-hosted, trading-live]`:
     - Security / gitleaks
     - Shared package pin check
     - Playwright Smoke
     - CI `verify-self` (only when route=self; usually skipped)
   - Result: **21+ pin-check jobs queued forever**, gitleaks never completes, smoke pile-up.
   - Merge often blocked on gitleaks even though the ruleset's only required context is `verify`
     (classic protection / expected checks still surface gitleaks).

3. **Smoke-on-every-PR load (secondary)**
   - Playwright Smoke was not ruleset-required but still fired on every PR and competed for
     capacity (and was pinned to offline trading-live).

4. **Not the main issue (this week)**
   - Merge conflicts: many PRs are MERGEABLE; "DIRTY" is often phantom or re-created by main
     advances, not the multi-day root cause.
   - Review comments: unresolved thread counts were ~0 on the Claude desktop set.

## Fixes in this change

| File | Change |
|------|--------|
| `security.yml` | gitleaks `trading-live` -> `socratic-ci` |
| `shared-package-pin-check.yml` | pin check `trading-live` -> `socratic-ci` |
| `e2e.yml` | remove `pull_request`/`merge_group` triggers (smoke on main/nightly/manual only); runners -> `socratic-ci` |

## Ops follow-ups (not in this PR)

- Fleet freeze: no ST branch pushes while `verify` is in_progress for that PR.
- Prefer exclusive serial merge train: 1-2 PRs at a time until queue < 10.
- Optional later: second dedicated runner or restore trading-live for Mac-only lanes.
- Land remaining queue via auto-merge once verify+gitleaks go green without cancel.

## Verification

- Confirm runners: `gh api repos/.../actions/runners`
- After merge+deploy of workflows: new gitleaks/pin-check jobs should run on socratic-ci.
- Cancel stuck queued Smoke / pin-check jobs waiting on trading-live.
