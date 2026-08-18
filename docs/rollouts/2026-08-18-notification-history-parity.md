# 2026-08-18 — Notification history + web/iOS inbox parity

## Context & Objective

Jay asked for notification history (page, sheet, or inbox) and more user-visible parity between the website and iOS.  Toasts and lock-screen banners disappear.  Users need to reopen later alerts with time, title/body, and whether they were read.  Persist across refresh / relaunch.  Reasonable recency is enough — not a huge archive product.

## Changes Made

Web already had Activity → Alert Center on `notification_events` (ack, filters, mute).  iOS had APNs delivery and no inbox.  This PR reuses that store and ack API.

- Slim last-100 history items on `GET /api/mobile/snapshot` (`title`/`body` already worded; no raw payload).
- iOS Activity opens with a Notifications list (Unread / All, Mark as Read, unread badge on the Activity tab).
- Website header bell inbox (time, title/body, read) plus unread badges on Activity nav.  `?tab=alerts` opens Alert Center.  Command palette gains Notifications.

Touched files:

- `src/lib/notification-history.ts`
- `test/notification-history.test.ts`
- `app/api/mobile/snapshot/route.ts`
- `app/console/components/notification-inbox.tsx`
- `app/console/components/shell.tsx`
- `app/console/components/nav.tsx`
- `app/console/components/command-palette.tsx`
- `app/console/activity/page.tsx`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTrade/PreviewSupport.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-08-18-notification-history-parity.md`

## Decisions & Trade-offs

- Reused `notification_events` and `POST /api/notifications/ack`.  No second backend.
- Recency window is the existing dashboard cap of 100 rows.
- iOS history is a section on Activity (same place push taps already land: `/console/activity`), not a new tab.
- Did not port Alert Center mute / provider rollup / delivery-failure filters to iOS.  Mark as Read is the shared action.
- Did not add iOS Settings channel prefs (email / Pushover / event toggles).  Device alerts stay in Account & Settings.
- Did not touch trading, broker, OpenRouter, RAG, or health-gate code.
- Separate from #2831, #2812, #2830, #2800, and the HOTFIX deploy.
- Coolify `watch_paths` includes this web/src change, so merge will rebuild production.  This PR is opened, not merged.

## Verification State

```
npm run lint            # exit 0 (warnings only; no new errors)
./node_modules/.bin/tsc --noEmit   # exit 0
./node_modules/.bin/vitest run test/notification-history.test.ts \
  test/notification-lifecycle.test.ts test/alert-center-incident-grouping.test.ts \
  test/alert-mutes.test.ts test/notify.test.ts test/notify-push-sanitize.test.ts \
  test/notification-status-truth.test.ts test/policy-notification-events.test.ts
  # 8 files / 73 passed
npm run build           # Next.js 16.3.1 webpack, exit 0
```

Full `npm test` on this Linux VM hits leftover Yahoo/SEC/Alpaca 404s and strategy timeouts (untouched here; same residue noted on #2812).  No Mac pool; `xcodebuild` skipped.

## Next Steps & Blockers

- ASC TestFlight after merge if iOS changed (no Mac pool on this account; `xcodebuild` skipped).
- Do not merge during a window that needs origin up.
- Left gaps listed in the PR body (channel prefs, mute on iOS, full Strategy page on iOS).

## Zero-Code Findings

Investigation: website Alert Center already persisted history with `acknowledgedAt`.  Mobile snapshot omitted `notifications`.  iOS Activity showed fills and recent actions only.  Highest-value missing screen Jay hits is therefore the iOS inbox plus a website header inbox so a toast is not the only reopen path.
