# 2026-08-12 - apns-push-ios

## Context & Objective

The iOS app had no push at all: no `aps-environment` entitlement, no APNs registration, no
`UNUserNotificationCenterDelegate`, no notification routing.  APNs auth-key secrets are already
set in Infisical (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY_B64`) and a
parallel agent owns the server sender + `POST /api/mobile/push/register`.  This note covers the
**device half only** — no `src/**` or `app/api/**` file was touched.

## Changes Made

Registration, delivery, tap-routing, and sign-out for APNs on the device, plus the entitlement
that makes any of it possible.

- `ios/SocraticTrade/SocraticTrade.entitlements` — adds `aps-environment: production`.
- `ios/project.yml` — adds the SAME key under the target's `entitlements.properties`.  xcodegen
  REWRITES the .entitlements file from this block on every `xcodegen generate`, so an entitlement
  added to only one of the two is silently dropped by the next regen.  Both were edited together
  and the survival of the key across a regen was verified.
- `ios/SocraticTrade/PushNotifications.swift` (new) — `APNSEnvironment` (+ provisioning-profile
  parsing), `PushRegistrationRequest`, `PushPayload`, `PushAlertState`,
  `PushNotificationCoordinator`, `PushAppDelegate`.
- `ios/SocraticTrade/DeepLink.swift` (new here, **taken verbatim** from the unlanded peer branch
  `origin/monet/ios-order-cancel` — see Decisions).
- `ios/SocraticTrade/MobileAPIClient.swift` — `productionBaseURL`, `registerPushToken`,
  `unregisterPushToken`.
- `ios/SocraticTrade/SocraticTradeApp.swift` — `@UIApplicationDelegateAdaptor(PushAppDelegate)`,
  the `pendingDeepLink` slot, `onOpenURL`, coordinator wiring, launch re-registration.
- `ios/SocraticTrade/MobileControlView.swift` — consumes `pendingDeepLink` through the existing
  rerouting `selection` binding.
- `ios/SocraticTrade/ProposalsView.swift` — the one place the app asks for permission.
- `ios/SocraticTrade/HomeView.swift` — "Alerts" section in Account & Settings; Sign Out now goes
  through `store.signOut()`.
- `ios/SocraticTrade/MobileStore.swift` — `signOut()`; `clearLocalSession()` forgets the token.
- `ios/SocraticTradeTests/PushNotificationTests.swift` (new), `ios/SocraticTradeTests/DeepLinkTests.swift`
  (verbatim from the peer branch).
- `ios/Socratic Trade.xcodeproj/project.pbxproj` — regenerated; objectVersion header re-applied.

## Decisions & Trade-offs

**Entitlement value is `production`.**  TestFlight and the App Store are the same APNs
environment (`api.push.apple.com`); a TestFlight build is a Release build re-signed by Apple with
a *distribution* profile.  Xcode's automatic signing (already `CODE_SIGN_STYLE: Automatic`)
substitutes `development` when building against a development profile, so local Xcode runs still
get sandbox tokens.  This was verified empirically, not assumed: after the change, the built
app's `embedded.mobileprovision` reads `aps-environment = development` while the checked-in
entitlements file says `production`.

**Environment is read from the signature, never from `#if DEBUG`.**  `APNSEnvironment.current`
locates the XML plist inside the CMS-wrapped `embedded.mobileprovision` and reads
`Entitlements.aps-environment`.  `#if DEBUG` describes optimization settings, not signing: a
Release build run from Xcode with a development profile gets *sandbox* tokens, and a Debug
archive would get production ones.  Unknown/unreadable profile on a real device resolves to
`production`, because a shipped install is the only realistic cause and guessing sandbox there
recreates exactly the silent `400 BadDeviceToken` failure this is meant to prevent.  The
simulator always resolves to `sandbox`.

**Permission is requested on first visit to Proposals while signed in** — the screen whose
entire purpose is "things are waiting for your judgment", which is what a push would be about.
Not at cold start (that asks about alerts from an app the owner has not seen) and not before
sign-in.  Account & Settings carries a manual "Turn On Alerts" for anyone who never opens that
tab, so the trigger is a convenience, not a gate.

**Foreground presentation is conditional on the SSE stream.**  While the live stream is
connected the screen already reflects the event, so the banner and sound are suppressed and the
notification is delivered to Notification Center and the badge only.  When the stream is DOWN the
screen is stale and the notification is the only signal, so the banner is shown.  A flat
"suppress in foreground" would hide real news precisely when the app has stopped receiving it.

**One router, reused — but the router came from an unlanded branch.**  The brief described an
existing `DeepLink` parser and pending-destination mechanism "that universal links already use".
That code exists on `origin/monet/ios-order-cancel` (peer, unmerged); it is NOT on `main`, which
is this branch's base.  Rather than write a second parser, `DeepLink.swift` and `DeepLinkTests.swift`
were copied **byte-identical** from that branch so an add/add merge resolves cleanly, and push
taps route through `DeepLink.destination(for:)` into the same `pendingDeepLink` slot `onOpenURL`
uses, consumed by the same rerouting `selection` binding (so a link to an unpinned screen still
lands in the More stack).  Two consequences worth knowing:

- The proposal-focus ring (`focusedProposalId`) from that branch was NOT copied — it depends on
  their `ProposalsView` changes.  `MobileControlView` here mirrors their shape minus the ring, so
  a human merge is small but not automatic.
- `applinks:` / the AASA route were NOT added (peer scope).  Until they land, `onOpenURL` will not
  fire for `https://socratictrade.com/...`; push routing does not depend on it, because the app
  parses the payload string itself rather than asking iOS to open a URL.

**Sign-out withdraws the token before clearing cookies.**  `MobileStore.signOut()` awaits
`DELETE /api/mobile/push/register` first — `clearLocalSession()` deletes the session cookies, and
a delete sent after that would arrive unauthenticated, leaving the device registered to a
signed-out user.  It also calls `unregisterForRemoteNotifications()` so that if the delete fails,
the token is invalidated system-side and the server's next attempt gets `410 Unregistered` and
cleans itself up.  The expired-session path (`clearLocalSession` from a 401) cannot make an
authenticated call, so it only drops the local belief.

**Honest state.**  `PushAlertState.isWorking` is true only for a completed server registration.
Denied permission, an APNs failure, and a rejected token all surface verbatim in the Account &
Settings "Alerts" section with the real reason and the appropriate next step (Open iOS Settings /
Try Again).  The app never implies alerts are arriving when they are not.

**Server-contract assumptions** (the parallel agent had not defined these; chosen and stated):

- `environment` is sent as the literal strings `"sandbox"` / `"production"`.
- `token` is lowercase hex, no separators (what APNs' `/3/device/<token>` path wants).
- `bundleId` is sent when known, omitted when blank.
- Unregister is `DELETE /api/mobile/push/register` with `{ token }` — the token is included so
  signing out on one device does not silence another device the same owner is still signed in on.
- The deep link is read from `url` / `deepLink` / `link` at the payload root, then from the same
  keys inside a `data` object.  It must be an `https://socratictrade.com/...` URL — `DeepLink`
  rejects the custom scheme, foreign hosts, and `http`, so a payload cannot drive the app
  anywhere a universal link could not.

## Verification State

```
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project "Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'platform=macOS,variant=Designed for iPad' test
```

`** TEST SUCCEEDED **` — **Executed 70 tests, with 0 failures (0 unexpected)** (was 44 before
this change: +17 push, +8 deep-link, +1 payload/router boundary).

Also verified by hand:

- `xcodegen generate` preserves `aps-environment` in the regenerated .entitlements (the trap this
  repo has been bitten by).
- The signed app bundle carries an `embedded.mobileprovision` whose `Entitlements.aps-environment`
  is `development` for this local build — i.e. the App ID's push capability is live, automatic
  signing downgrades correctly, and `APNSEnvironment.current` will report `sandbox` here and
  `production` from TestFlight.

Not verified (needs a real device + the server half): an end-to-end push delivery.

## Next Steps & Blockers

- End-to-end test once the server sender lands: TestFlight build -> confirm the registration row
  says `production` -> send -> confirm tap lands on Proposals.
- Reconcile with `origin/monet/ios-order-cancel` when either branch lands: `DeepLink.swift` and
  `DeepLinkTests.swift` are byte-identical, `MobileControlView.swift` and `SocraticTradeApp.swift`
  need a small manual merge (their proposal-focus ring on top of this pending-link wiring).
- If the server disagrees with any assumption above, only `PushRegistrationRequest.jsonBody`,
  `PushPayload.linkKeys`, and the two `MobileAPIClient` paths need to change.

## Zero-Code Findings

The brief's premise that a deep-link router already existed on `main` was inaccurate — it lives
on an unmerged peer branch.  Recorded here so the next agent does not go looking for it in
history and conclude it was deleted.
