# 2026-07-24 — Fix Actions runners + unstick CI (CURSOR)

## Summary

Unblocked the self-hosted CI pool and fixed workflows that were failing on every
main push: Cleanup Actions Caches (GitHub-hosted billing block), Playwright Smoke
(`sudo` denied on Coolify runners), and Effort Issues Sync (hard-fail on GitHub 504).

## Why

- `ubuntu-latest` jobs annotate: "recent account payments have failed or your
  spending limit needs to be increased" — they never start.
- Self-hosted `socratic-ci` runners were busy; Sentry CI Report spam + failing
  hosted cleanup jobs aggravated the queue.
- Playwright `install --with-deps` requires sudo the Coolify image does not grant.
- Effort sync treated 504 as fatal; large board updates trip GitHub gateway timeouts.

## Files

- `.github/workflows/cleanup-caches.yml`
- `.github/workflows/e2e.yml`
- `scripts/sync-effort-issues.py`
- `STATUS.md`
- `docs/rollouts/2026-07-24-fix-runners-unstick.md`
- `docs/EFFORT-LOG.md` (claim row)

## Verification

- Cancelled queued Sentry CI Report spam on Socratic.Trade
- Inspected Cleanup Actions Caches annotations (billing) + Playwright sudo error
- Local script syntax check: `python3 -m py_compile scripts/sync-effort-issues.py`
- Usage-Monitor PR #796 squash-merged (CLEAN)
- Congress.Trade: stale executive-skip test updated to match `5264fe9` behavior

## Follow-ups

- Owner: restore GitHub Actions spending limit / billing so hosted runners work again
- Babysit #2157 if still open (earlier self-hosted cleanup attempt; may conflict)
- Congress Deploy Deno "Top-level await promise never resolved" looks flaky — separate
- Draft Congress #898 (effort sync reopen fix) still needs review/land
