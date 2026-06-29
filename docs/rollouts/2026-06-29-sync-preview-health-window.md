# Sync preview health window

## Summary

`scripts/sync-preview-lanes.sh` now gives preview lanes a longer, configurable
warm-up window after PM2 restarts before failing health/root checks. Defaults:
5 seconds of post-restart settling, then 30 attempts at 3-second intervals for
each URL probe.

## Why

The `sync-previews` CI job for main commit
`22fa44d476c4f0f7bc430b26c45da7c3bf70997f` fast-forwarded integration beta,
restarted `trading-main`, and immediately probed port 4001. The first few
responses were connection refused/reset/empty reply, consistent with Next dev
still warming up after restart, so the script rolled beta back and failed the
workflow even though the landed PR only changed dashboard styling classes.

## Files

- `.github/workflows/sync-previews.yml` (read only)
- `scripts/sync-preview-lanes.sh`
- `STATUS.md`
- `PLAN.md`
- `docs/deployment.md`
- `docs/rollouts/2026-06-29-sync-preview-health-window.md`

## Verification

- Pending: `bash -n scripts/sync-preview-lanes.sh`
- Pending: mocked local preview-sync run that forces initial curl failures before
  success
- Pending: `npm run lint`
- Pending: `npx tsc --noEmit`
- Pending: `npm test`
- Pending: `npm run build`

## Follow-ups

- If a future sync failure still times out after the longer window, inspect the
  PM2/Next logs for a real runtime boot error before increasing these defaults.
