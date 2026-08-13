# APNs native push — server side (device registry, provider client, delivery channel)

## 1. Context & Objective

The iOS app has no native push today: out-of-app alerts only reach a phone via ntfy/Pushover/SMS.
The iOS/web parity panel prioritized four events for native delivery — pending proposal, fill,
triggered price alert, run failure.  This change builds the SERVER half: a device-token registry, a
session-authenticated registration endpoint, an APNs provider client, and push wired in as a new
DELIVERY CHANNEL inside the notification system the app already has.  A parallel agent owns the
`ios/**` side; nothing under `ios/` is touched here.

The load-bearing architectural constraint: push is **not** a parallel notification pipeline.  It is
one more `NotifyChannelId` in `src/lib/notify.ts`'s `CHANNELS` record, reached through the same
`sendNotification` -> `notify` path as every other channel, and gated by the same
`policy.notificationSettings.enabledEvents`.  No second `enabledEvents`-like concept was added.

## 2. Changes Made

### Architecture

```
sendNotification (notifications.ts)   <- existing per-event gate (enabledEvents) + repeat-dedup
  └─ notify (notify.ts)               <- existing per-user channel fan-out (notification_prefs)
       └─ CHANNELS.apns               <- NEW channel
            ├─ listActiveDeviceTokens(userId)      (db-device-tokens.ts)
            ├─ pushDeepLink / pushCollapseId       (push-deep-links.ts)
            └─ sendApnsPush per device             (apns.ts, node:http2 + ES256 JWT)
```

The `apns` channel differs from the others in exactly one way: its delivery target is app-managed
(the device tokens the iOS app registered) rather than a string the user types in Settings.  That
required two small, general extensions rather than a special case:

* `ChannelDef.resolveTarget?({ userId, prefs })` — an optional override for channels whose target is
  app-managed.  It returns the live device COUNT (never a token — the value flows into result
  bookkeeping), and `""` means "no target", which the existing loop already reports as
  `skipped: "no_target"`.
* `ChannelSendContext.userId` — channels now receive the user the delivery belongs to.

### Files touched

* `src/lib/types.ts` — `NotifyChannelId` gains `"apns"`; new `ApnsEnvironment` and `DeviceToken`;
  `NotifyChannelDescriptor.managedTarget?`.
* `src/lib/db.ts` — migration **75 `device_push_tokens`**; barrel re-export of `db-device-tokens`.
* `src/lib/db-device-tokens.ts` — **new.** Registry CRUD: `registerDeviceToken` (reassign-on-conflict),
  `listActiveDeviceTokens`, `countActiveDeviceTokens`, `getDeviceToken`, `disableDeviceToken`,
  `unregisterDeviceToken` (owner-scoped), `touchDeviceToken`, `normalizeDeviceToken`,
  `maskDeviceToken`, `isApnsEnvironment`.
* `src/lib/apns.ts` — **new.** Provider client: config loader, cached ES256 provider JWT, HTTP/2
  transport, `sendApnsPush` with response classification.
* `src/lib/push-deep-links.ts` — **new.** Universal-link URL + collapse-id derivation per event type.
* `src/lib/notify.ts` — `apns` channel, `NotifyConfig.apns`, `resolveTarget` seam,
  `CHANNEL_CAPABILITIES.apns`, `apnsTransport` injection point.
* `src/lib/notifications.ts` — `CHANNEL_LABELS.apns`.
* `src/lib/db-api-keys.ts` — `"apns"` added to `NOTIFY_CHANNEL_IDS` so prefs accept it.
* `src/lib/account-deletion.ts` — `device_push_tokens` added to `DELETE_TABLES_BY_USER_ID`.
* `app/api/mobile/push/register/route.ts` — **new.** POST register / DELETE unregister.
* `app/console/settings/delivery.tsx`, `app/console/settings/lib.ts` — render the managed-target
  channel as an explanation instead of an empty text input.
* `next.config.mjs` — `http2: false` client/edge resolve fallback.
* `test/apns-push.test.ts`, `test/apns-register-route.test.ts` — **new** (34 tests).
* `test/persistence-hardening.test.ts` — schema-version expectations 74 -> 75.

### Registration contract

```
POST /api/mobile/push/register
  auth: session (x-authenticated-user-email, set by middleware — never the body)
  body: { token: string, environment: "sandbox" | "production", bundleId?: string }
  200:  { ok: true, device: { token: "<masked>", environment, bundleId, platform, createdAt, lastSeenAt } }
  400:  malformed token / bad environment / bundleId != this server's APNs topic

DELETE /api/mobile/push/register
  body: { token: string }
  200:  { ok: true, removed: boolean }
```

Idempotent: re-POSTing the same token refreshes it (200, no duplicate row, original `createdAt`
preserved).  Registering also adds `"apns"` to the user's `notification_prefs.channels` — allowing
notifications on the device IS the opt-in — and the last DELETE removes it again.  The user can
still turn the channel off in Settings -> Delivery and that is honored on the next send.

Rate-limited 30/min per user, same as the other mobile routes.  The raw token is never echoed back,
logged, or audited — only `maskDeviceToken` form (`abc123...ef01`).

## 3. Decisions & Trade-offs

* **Token reassignment, not multi-owner.** `device_push_tokens.token` is the PRIMARY KEY and
  registration reassigns on conflict.  Apple hands the same device token to the same app install
  regardless of who is signed in, so an "insert a second row" model would keep delivering the
  previous user's alerts to a shared phone.  Reassignment is the security property; it is tested
  at both the registry and the route level.
* **Environment is stored, never inferred.** Endpoint selection reads the token row, not `NODE_ENV`.
  TestFlight is PRODUCTION; assuming otherwise is a silent-failure bug (400 BadDeviceToken forever).
* **Dead tokens are disabled, not deleted.** A 410 `Unregistered` / 400 `BadDeviceToken` sets
  `disabled_at` + `disabled_reason` so the row still explains itself; it is never sent to again, and
  re-registering re-enables it (reinstall / re-granted permission).
* **JWT cached at 50 minutes.** Apple requires >= 20 minutes of reuse and expiry at 60.  Minting per
  send earns `429 TooManyProviderTokenUpdates`.  A `403 ExpiredProviderToken` invalidates the cache
  so the next send re-mints instead of replaying a rejected token.
* **`node:http2`, never fetch.** APNs is HTTP/2-only and Node's global fetch/undici does not speak
  HTTP/2 to it.  One short-lived session per request: volume here is a handful of alerts per user
  per day, so pooling buys nothing while a cached half-open session is a real source of stuck sends.
* **Bare `crypto`/`http2` specifiers.** `src/lib/apns.ts` is reachable from the `src/lib/db.ts`
  barrel, which Next compiles into client/edge bundles.  A `node:`-scheme request is handled by
  webpack's scheme plugin BEFORE `resolve.alias`, so the config's existing `"node:crypto": false`
  alias cannot neutralize it and the build fails `UnhandledSchemeError`.  Bare specifiers go through
  `resolve.fallback`, where `crypto`/`http2` map to `false` off-server.  This is why
  `next.config.mjs` gained `http2: false`.
* **No per-event gate of its own.** Deliberate.  `sendNotification` checks `enabledEvents` before
  `notify()` is ever called, so a disabled event cannot reach the channel.  Adding a push-specific
  event list would be the parallel-pipeline mistake this design exists to avoid.
* **Collapse ids on the noisy repeats only.** `pending_approval` (`approval-<SYM>-<side>`),
  `run_failed`, `kill_switch`, `price_alert`, `limit_order_stale`.  `fill` deliberately has NONE —
  two fills are two events and neither may replace the other on the lock screen.
* **Deep links point at routes that exist.** Every shape resolves to a real `app/console/*` page, so
  the same URL works on web/PWA if the app is not installed.  Ids are ALSO repeated as top-level
  payload fields, so an iOS router can match on the path alone or on structured data:
  * `pending_approval` -> `https://socratictrade.com/console/approvals?proposal=<id>`
  * `fill` -> `https://socratictrade.com/console/orders?symbol=<SYM>`
  * `price_alert` -> `https://socratictrade.com/console/watchlist?symbol=<SYM>`
  * `run_failed` -> `https://socratictrade.com/console/activity`
  * fallback -> `https://socratictrade.com/console`
  `ios/SocraticTrade/DeepLink.swift` does not exist on `main` (the app has no universal-link handler
  yet); the iOS agent owns adding one and should match these paths.
* **Secrets by name from the process env** (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`,
  `APNS_PRIVATE_KEY_B64`) — the same seam `RESEND_API_KEY` / `TWILIO_*` use in `loadNotifyConfig`;
  the Infisical runner injects them (`src/lib/secrets-source.ts`).  No key was created, rotated, or
  printed.  A missing/partial credential set makes `loadApnsConfig` return `null` and the channel
  report `skipped: "not_configured"` — it never throws.

### Fail-soft posture

A push failure cannot break or block the trading path that triggered it.  Three layers:

1. `sendApnsPush` returns an `ApnsSendResult` for every outcome including transport throws — it does
   not reject.
2. `notify()` already catches per-channel failures and continues to the remaining channels.
3. `sendNotification` wraps the whole direct-delivery bridge in try/catch and records the failure as
   notification metadata.

`resolveTarget` is additionally wrapped in the dispatch loop so a registry read hiccup degrades to
"no target" rather than aborting the loop for the other channels.

## 4. Verification State

Run in the foreground from `/Users/jay/apps/trading-monet-apns-server` with
`PATH="/opt/homebrew/opt/node@24/bin:$PATH"`:

```
npx tsc --noEmit          # exit 0, no output
npm run lint              # 0 errors, 750 warnings (pre-existing grandfathered backlog)
npm test                  # Test Files 551 passed | 1 skipped (552)
                          # Tests 6397 passed | 51 skipped (6448)
npm run build             # exit 0; /api/mobile/push/register listed as a dynamic route
npx vitest run test/apns-push.test.ts test/apns-register-route.test.ts
                          # Test Files 2 passed (2) — Tests 34 passed (34)
```

Two pre-existing suites needed updating for the new migration and are green:
`test/persistence-hardening.test.ts` (schema version 74 -> 75) and
`test/account-deletion-coverage.test.ts` (which correctly caught that `device_push_tokens` would
have escaped account deletion — fixed in `src/lib/account-deletion.ts`, not by editing the test).

Test coverage of the required behaviors: registry reassignment (registry + route level), prefs
gating (disabled event makes zero APNs requests; the four prioritized events each push with the
right deep link), 410/400 token cleanup, JWT reuse window (identical inside 50 min, refreshed after,
refresh < Apple's 60 min), endpoint selection by stored environment, fail-soft on send error (other
channels still deliver; the notification still reports `sent`), and unconfigured-credential
degradation (`skipped: "not_configured"`, no crash).

## 5. Next Steps & Blockers

* **iOS side (parallel agent):** register for remote notifications, POST the token to
  `/api/mobile/push/register` with the correct `environment` (`sandbox` for Xcode debug builds,
  `production` for TestFlight/App Store), DELETE on sign-out, and add a universal-link router
  matching the paths above.  The `aps-environment` entitlement must match the build.
* **Production check after deploy:** confirm all four `APNS_*` values are present in the ST prod
  Infisical project; without them Settings -> Delivery shows "iPhone push — not configured" and
  nothing is sent (by design).
* **Not built (out of scope, deliberate):** an operator-facing "send a test push" action, a stale-
  device sweep using `last_seen_at`, and APNs push types other than `alert`.

## 6. Zero-Code Findings

`ios/SocraticTrade/DeepLink.swift` referenced in the task brief does not exist on `main`, and
`grep` finds no `onOpenURL`/`applinks` handling anywhere under `ios/` — the app currently has no
universal-link routing at all.  The URL shapes above were therefore derived from the web routes that
actually exist under `app/console/` rather than from an existing iOS router, and are documented here
as the contract for the iOS agent to implement against.
