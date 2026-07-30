## 2026-07-30 — Pushover Notification Channel Support (ANTIGRAVITY, branch `agent/antigravity-pushover`)

Added Pushover as a standalone notification channel inside `notification_prefs`:
1. Updated types `NotifyPrefs` and `NotifyChannelId` in `src/lib/types.ts`.
2. Created a new SQLite migration `063-notification-prefs-pushover.sql` and appended versioned migration 63 to `src/lib/db.ts` to add the `pushover_target` column. Also hardened the migration to support isolated partial test schemas.
3. Updated `app/console/settings/delivery.tsx` and `lib.ts` to allow configuring the Pushover User Key.
4. Separated out Pushover from the legacy ntfy Push system in `src/lib/notify.ts` to construct its own dedicated REST POST payload to `api.pushover.net`.
5. Updated `src/lib/db-api-keys.ts` to save and extract the target appropriately.

All 5000+ tests, the TypeScript compiler, and the linter pass. Changes pushed and merged via `scripts/land.sh`.

## Blockers
- None.

## Next Action
- Wait for user instructions or close ticket.
