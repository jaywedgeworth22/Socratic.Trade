# Per-user delivery-channel credentials (Pushover app token + Twilio set) (2026-07-31)

## Context & objective

Owner directive: "pushover token and twilio should be user specific and
configured in user settings." Until now, channel *credentials* were
server-env-only (`PUSHOVER_APP_TOKEN`, `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM`)
while users could only set *targets* (user key, phone). That made enabling a
channel an ops task (Infisical + restart) and blocked self-serve entirely —
the "Pushover not configured on the server" dead end the owner hit.

## Changes made

- **Migration v64** (`notify_per_user_channel_credentials`, `src/lib/db.ts`):
  `notification_prefs` gains `pushover_app_token`, `twilio_account_sid`,
  `twilio_auth_token`, `twilio_from` (TEXT, default '').
- `src/lib/types.ts` — `NotifyPrefs` gains presence flags
  (`pushoverAppTokenSet`, `twilio*Set`); new server-only `NotifyPrefsSecrets`.
- `src/lib/db-api-keys.ts` — `getNotifyPrefsSecrets(userId)` decrypts via the
  existing field-level `encryptValue`/`decryptValue` (AES-256-GCM `v1:`
  envelope, `ENCRYPTION_KEY`); `setNotifyPrefs` accepts the four credential
  fields with **undefined = keep, "" = clear, non-empty = encrypt+replace**
  semantics and audits `notify.prefs.secret_set` (column + action only,
  never values). The API-facing prefs object never contains the values.
- `src/lib/notify.ts` — new `loadUserNotifyConfig(userId)`: per-user
  credentials **win over** server env; unset fields **fall back to env**, so
  operator-configured env keeps working for users without their own.
  `notify()` now resolves config per user (explicit `deps.config` still wins
  for durable/test callers). Pushover `describe()` uses cfg, not raw env.
- `app/api/notifications/route.ts` — GET passes the per-user effective config
  to `describeChannels` (availability reflects user creds); POST accepts the
  four credential fields.
- Settings UI (`app/console/settings/delivery.tsx`, `lib.ts`) — Pushover row
  gains "Pushover application API token"; SMS row gains Twilio Account SID /
  Auth Token / sender number. Password inputs, write-only: placeholder shows
  "Saved — enter to replace" when set, Remove button clears. Fields are
  always visible for those channels (they are how you fix "not configured"
  without server setup). Untouched inputs are never sent, so they can't
  accidentally clear stored values. Copy updated: "not configured on the
  server" → "not configured" (it's no longer necessarily a server problem).
- `test/notify-user-creds.test.ts` (new, 11 tests) + one fixture update in
  `test/notification-status-truth.test.ts`.

## Decisions & trade-offs

- User value **wins** over env (explicit > implicit); env remains as
  operator-level fallback/default. `TWILIO_FROM` is encrypted too for
  uniformity even though it's low-sensitivity.
- Secret fields are write-only over the API (presence flags back) — same
  pattern as the API-keys settings page.
- The whole-object settings POST drops undefined keys (JSON.stringify), which
  is what makes "untouched = keep" safe with auto-save-on-blur.

## Verification state

- `npx tsc --noEmit` clean; `npx vitest run` on the six notify-adjacent files:
  82/82 green (11 new). Full suite + build delegated to required `verify` CI.
- Prod rollout note: after deploy, the owner pastes their own Pushover app
  token (pushover.net/apps) + user key in Settings → Delivery — no Infisical,
  no restart. The Twilio set will be mirrored into the owner's user settings
  by an agent post-deploy (values already verified working earlier today).

## Next steps & blockers

- Post-deploy ops: write the existing working Twilio creds into the `local`
  user's settings row (encrypted) so they're truly user-specific; env copies
  stay as fallback.
- Owner: create the Pushover application token (pushover.net/apps) and paste
  it + user key in Settings → Delivery; Send test to verify.
