# 2026-09-08 - ci-deploy-freshness-monitor-margin

## Summary

Widened the Sentry Crons `checkin_margin` used for the `ci-deploy-freshness`
monitor (workflow `Deploy freshness`, `.github/workflows/deploy-freshness.yml`)
from 15 minutes to 600 minutes (10h), via a new per-workflow
`CRON_CHECKIN_MARGIN_MINUTES` override in `scripts/sentry-ci-report.py`. No
other monitor's margin changed (default stays 15 min). The workflow's own
declared cadence (`schedule: cron: "13,33,53 * * * *"`, i.e. every 20 minutes)
is unchanged.

## Why

Sentry issue **FLEET-INFRA-C1** / PagerDuty **#87** flagged the
`ci-deploy-freshness` Crons monitor as regressed (active incident since
2026-09-08T18:13Z). Investigation (`GET
/organizations/jays-services/monitors/ci-deploy-freshness/`, `gh run list
--workflow deploy-freshness.yml`) found:

- The workflow itself is healthy: every run since it was created
  (2026-08-20) concluded `success`. It has never failed.
- GitHub's `schedule` trigger for this workflow is delivered on a
  best-effort basis and, empirically, delivers far less often than declared.
  Over the 211 hours before this fix (2026-08-30T22:43Z .. 2026-09-08T18:03Z),
  only 60 of the ~634 scheduled fires GitHub should have created for a
  20-minute cron actually ran (~9.5% delivery). Every gap between consecutive
  runs exceeded 60 minutes; median gap 210.5 min; p99/max 483.6 min
  (~8h03m). (`gh run list --workflow deploy-freshness.yml --limit 60 --json
  databaseId,event,status,conclusion,createdAt`, filtered to `event ==
  "schedule"`.)
- The Sentry monitor's `checkin_margin` was hardcoded to 15 minutes for
  every schedule-triggered workflow in this script, so it was structurally
  guaranteed to open a "missed check-in" incident every few hours against a
  job that was never actually broken — a false page, not a real regression.
  Each successful check-in re-upserts `monitor_config` from this script
  (`isUpserting: true` on the live monitor), so the false-page cycle would
  repeat indefinitely without a code change here.

This is category (b) from the remediation runbook: the workflow runs fine,
but the monitor's margin didn't match GitHub's real scheduling delivery.

600 minutes (10h) sits with headroom above the worst gap measured so far
(~8h03m) while still alerting well inside the 14-hour silent-deploy-freeze
(2026-08-06) that this watchdog exists to catch — the workflow compares
`origin/main` against the live `/api/health` release SHA and independently
fails/pages Slack on genuine staleness (`DEPLOY_FRESHNESS_STALE_SECONDS=3600`)
every time it *does* run, regardless of this Sentry margin. The Sentry Crons
monitor here answers a narrower question — "is the watchdog itself still
alive" — and needed calibrating to what GitHub can actually deliver, not to
the aspirational cron string.

The crontab schedule itself was left untouched: it documents the intended
cadence and is what a healthy GitHub scheduler would honor; only the
tolerance for GitHub's own delivery jitter changed.

## Files

- `scripts/sentry-ci-report.py` — added `CRON_CHECKIN_MARGIN_MINUTES` dict
  (default 15 min, override 600 min for `"Deploy freshness"`); checkin
  payload now reads the margin from `CRON_CHECKIN_MARGIN_MINUTES.get(workflow_name,
  15)` instead of a bare `15`.
- `docs/EFFORT-LOG.md` — mirror row for this effort.

## Verification

- `python3 -m py_compile scripts/sentry-ci-report.py` — clean.
- Manually replayed both assertions in `test/sentry-ci-report-workflows.test.ts`
  (coverage + cron-mapping regex extraction) against the edited file in Node
  outside vitest, since this throwaway clone has no `node_modules`:
  - "observes every active workflow and no retired workflow" — unaffected
    (this test never reads `CRON_CHECKIN_MARGIN_MINUTES`).
  - "maps every active scheduled workflow to its exact source cron" — the
    test's regex only extracts the `CRON_SCHEDULES = { ... }` block (matches
    up to the first `\n}`), which is unchanged; confirmed byte-for-byte with
    the test's own extraction regex, and confirmed the resulting object is
    still deep-equal (order-independent) to the workflows' declared crons.
- Full `npm test` / `npx tsc --noEmit` / `npm run lint` / `npm run build` were
  **not** run in this session (no `node_modules` in this scratch clone, and
  the change touches no TypeScript). CI's `verify` check on the PR is the
  gate of record; it exercises the real vitest run.
- Did **not** manually PUT the Sentry monitor config directly — the next
  successful check-in from this workflow will upsert it with the new margin
  automatically (`isUpserting: true`), which is the same mechanism that set
  the current (too-tight) config. See the parent remediation report for a
  direct PUT applied in the interim to stop paging immediately while this PR
  lands.

## Follow-ups

- The same GitHub Actions best-effort scheduling gap likely explains other
  fleet crons flagged stale/noisy elsewhere in `ci-deploy-freshness`'s own
  Sentry plan doc (`ai-fleet-coordinator/docs/plans/2026-09-01-sentry-fleet-integration.md`)
  — e.g. `usage-monitor-scheduler`, CT's `watcher-cron` /
  `agreement-autopublish-cron`. Not fixed here (out of scope for this one
  monitor); worth a fleet-wide pass on `checkin_margin` vs. observed GitHub
  Actions delivery cadence per short-interval scheduled workflow.
- FLEET-INFRA-C1 should be resolved once a check-in with the new
  `monitor_config` lands `ok` (or immediately, if the direct PUT below was
  applied) — not resolved purely on this PR merging, since GitHub may not
  fire the workflow again for hours.

## Blockers

- None. This PR is a pure config/tolerance change; no behavior of the
  `Deploy freshness` job itself changed.
