# 2026-06-29 - Preview sync health window

## Summary

The `sync-previews` workflow failed after advancing the integration beta worktree
to main commit `1640919` because the beta PM2/Next dev process did not answer
health/root checks before the script's short retry window expired. The sync
script now uses configurable health polling and defaults to 15 attempts with a
2-second delay before rolling a lane back.

## Why

The failed job showed `curl` connect, empty-reply, and connection-reset errors
for port `4001` immediately after restarting PM2, then rolled beta back to the
previous commit. The merged app change was UI/docs/env-example only, so this is
best handled as preview-sync restart tolerance rather than an application bug.

## Files

- `scripts/sync-preview-lanes.sh`
- `STATUS.md`
- `PLAN.md`
- `docs/deployment.md`
- `docs/rollouts/2026-06-29-preview-sync-health-window.md`

## Verification

Initial verification attempt:

- `bash -n scripts/sync-preview-lanes.sh && npm run lint && npx tsc --noEmit && npm test && npm run build`
  - Failed at `npm run lint` because the Cloud checkout did not have dependencies
    installed yet (`eslint: not found`).

Remediation and final verification:

- `npm ci`
  - Passed; existing npm deprecation/audit warnings only.
- `bash -n scripts/sync-preview-lanes.sh && npm run lint && npx tsc --noEmit && npm test && npm run build`
  - Passed.
  - `npm run lint`: 0 errors, 240 existing warnings.
  - `npx tsc --noEmit`: no errors.
  - `npm test`: 157 files / 1,516 tests passed.
  - `npm run build`: passed; existing Next.js middleware-to-proxy deprecation
    warning only.

## Follow-ups

- If the self-hosted beta lane still fails after the longer window, inspect the
  PM2 logs for `trading-main` on the Mac runner before increasing retries again.
