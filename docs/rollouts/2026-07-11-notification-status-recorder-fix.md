# Notification Status Recorder Fix

## Summary
Fixed the `sendNotification` implementation to accurately report delivery statuses ("sent", "skipped", "failed") by aggregating the results of all configured notification channels (e.g., webhook, ntfy push, email), rather than inaccurately reporting "skipped" simply because a webhook URL was not configured.

## Why
Activity-audit P2.5 identified that the notification status recorder "lies" by logging "skipped" or "failed" inaccurately. When a user relies on push notifications or email but has no webhook configured, the system reported "skipped: Notifications Webhook Not Configured", leading the dashboard UI to show "Not sent" even when delivery was successful via other channels.

## Files Touched
- `src/lib/notifications.ts`

## Verification
- Ran `npx tsc --noEmit && npm run lint` which completed successfully with 0 errors.

## Follow-ups
None for this specific task.
