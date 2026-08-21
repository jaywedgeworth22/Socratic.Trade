# 2026-08-21 - ios-wide-layout-admin-tab

## 1. Context & Objective

Owner asked for an iPad Air 11" / variable-window layout pass, settings gear top-right on
every tab, a larger settings sheet on iPad/Mac, Admin Portal as an admin-only tab on all
devices, deletion of the Assets price-alert composer, a bell top-left for notifications,
and a fix for Admin "Back to Console" loading the website inside the native webview.

This continues the 2026-08-21 adaptive tab bar (`TabBarCapacity` / `SnapshotScaffold`)
rather than replacing it.  The new work is chrome, Admin-as-tab, and the webview fence.

## 2. Changes Made

Regular-width windows (iPad, wide Mac Catalyst) opt into `.tabViewStyle(.sidebarAdaptable)`
so the system can convert the tab bar into a sidebar as the window grows.  Compact width
keeps the phone tab bar.  Card columns still come from `SnapshotScaffold` /
`ContentColumns` (iPad Air 11" portrait 2 columns, landscape 3).  Settings and the
notification inbox use `.presentationSizing(.form)` plus a 560x680pt floor on regular
width so they are not a tiny iPad card.

Every tab (including More and Admin) gets a leading bell and a trailing `gearshape`.
The bell opens the same persisted notification inbox Activity already showed.  The
Assets toolbar price-alert composer, `AlertsSection`, Home "Armed Price Alerts", and
Insights triggered-alert cards are gone.  Snapshot still decodes `alerts` so older
payloads do not break; there is no iOS create/delete entry point.

Admin Portal is `AppTab.admin`, offered only when `currentUser.isAdmin == true`.  On a
fresh iPad (six slots) auto-fill places it in the first extra slot.  On iPhone it lives
in More (and on Home Desk) until pinned.  The tab is a native rail of the eleven website
admin pages plus a fenced WKWebView.  Full navigations and Next.js `pushState` to
`/console` call `onBackToConsole` (Home tab) instead of painting the website.  Injected
CSS hides the web header/rail/"Back to Console" so native chrome is not duplicated.

- `ios/SocraticTrade/MobileControlView.swift` — `AppTab.admin`, admin-gated customizable
  list / auto-fill, sidebar-adaptable TabView, `.appChrome()` on every destination
- `ios/SocraticTrade/AppComponents.swift` — `AppLayout`, `AppChromeModifier`,
  `AdaptiveWideSheet`; SnapshotScaffold uses the same regular-width helper
- `ios/SocraticTrade/AdminPortalView.swift` — native rail + console-return intercept
- `ios/SocraticTrade/HomeView.swift` — gear CTA, settings extracted, price-alert row
  removed, Admin desk shortcut, settings no longer hosts the portal sheet
- `ios/SocraticTrade/MarketsView.swift` — price-alert UI deleted
- `ios/SocraticTrade/ActivityView.swift` — `NotificationsInboxView` for the bell
- `ios/SocraticTrade/InsightsView.swift` — triggered price-alert insight removed
- `ios/SocraticTrade/DeepLink.swift` — comment (Assets no longer hosts alerts)
- `ios/SocraticTradeTests/TabPreferencesTests.swift` — admin auto-fill / gate
- `ios/SocraticTradeTests/RunStateDerivationTests.swift` — console-return + page paths
- `ios/SocraticTradeTests/DeskModelsTests.swift` — Admin tab membership
- `ios/CLAUDE.md` — file map
- `docs/phase-8-cockpit-ui.md` — iOS chrome / Admin tab
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md` — this effort

## 3. Decisions & Trade-offs

UI-expert pass (this session inspected the live Swift, `app/console` chrome, and
`app/admin/layout.tsx`; no Task-spawn tool was available in the cloud agent):

1. **iOS chrome** — Settings lived only on Home (`person.crop.circle`).  Assets stole
   trailing for price alerts.  Coach/Scan already occupy trailing.  Recommendation:
   shared toolbar, gear as `confirmationAction` so it stays top-right next to those
   extras; bell leading, reusing `bell` / `bell.badge.fill`.
2. **Website console** — Header inbox + account control on every screen; Admin is an
   `isAdmin` link in chrome, not a buried sheet.  Match that on native.
3. **HIG / Admin** — Porting eleven React admin pages is out of scope.  Hybrid: native
   `NavigationLink` / sidebar list (the website NAV_ITEMS) + existing fenced WKWebView.
   Intercept `/console` both in `decidePolicyFor` and via a `pushState` script because
   Next.js client routing never becomes a full navigation (the actual bug).

Other decisions:

- Did not raise compact tab count when the user is an admin (5+More crowds an iPhone).
  Admin is always in More and auto-fills onto the bar from the fifth slot.
- Did not delete `/api/alerts` or website Watchlist price alerts.  Owner asked to remove
  the iOS Assets entry point.
- Did not add `/admin` to AASA / DeepLink.  The tab is in-app; claiming the path would
  swallow Safari operator links.
- New Swift files were avoided (checked-in pbxproj is explicit file refs; no xcodegen
  here).  Chrome lives in `AppComponents.swift`.

PR: [#3028](https://github.com/jaywedgeworth22/Socratic.Trade/pull/3028).

## 4. Verification State

Commands run in this Linux cloud VM (no `xcodebuild` / `swiftc` / `xcodegen`):

```bash
npm run lint          # exit 0 — 0 errors, 774 grandfathered warnings
npx tsc --noEmit      # exit 0
npm run build         # exit 0 — Next.js 16.3.1 webpack, TypeScript finished, 41 static pages
```

`npm test` (vitest) was started locally and aborted after ~15 minutes: a single
vitest worker plus outbound 404s (Yahoo, SEC `company_tickers.json`, Finnhub,
FRED) produced 30s timeouts in strategy/history tests that this iOS-only PR did
not touch.  CI `verify` on PR #3028 is the JS test of record.

iOS XCTest additions (`TabPreferencesTests`, `RunStateDerivationTests`,
`DeskModelsTests`) are not executed here.  First Swift compile is
`.github/workflows/ios-build.yml` on the Mac runner (`ios-build` on PR #3028).

`ios-build` run 32535072344 (head `cb44aeecef`, later docs-only commits did not
re-run the Mac job): BUILD SUCCEEDED, 237 XCTests, 1 failure.
`TabPreferencesTests.testAdminTabAppearsOnlyAfterTheSessionIsMarkedAdmin`
expected `[home, proposals, markets, activity, admin, insights]` and got
`[..., insights, admin]`.  Cause: `barTabs` filters `AppTab.allCases`, and
`.admin` was declared after `.results`, so canonical order buried it.  Fix:
declare `.admin` immediately after `.activity` so the first extra iPad slot
matches `autoFill`.  The follow-up commit is on this same PR.

## 5. Next Steps & Blockers

- Re-run `ios-build` after the Admin enum-order fix; confirm
  `testAdminTabAppearsOnlyAfterTheSessionIsMarkedAdmin` passes.
- Confirm Admin rail SF Symbols render on device/simulator.
- Screenshot iPad Air 11" portrait/landscape and a dragged Mac window (still open from
  the adaptive-tabs follow-ups).
- TestFlight ship is separate (`scripts/ios-ship-testflight.sh`); this PR does not ship.
- Website Watchlist still has price alerts; delete there only if the owner wants parity
  the other way.

## 6. Zero-Code Findings

The "Back to Console" bug is SPA `history.pushState` / `<Link href="/console">`, not a
hole in `isAllowed` (that already returned false for `/console` main-frame).  Cancelling
the policy is necessary but not sufficient; the script bridge is the actual fix.
