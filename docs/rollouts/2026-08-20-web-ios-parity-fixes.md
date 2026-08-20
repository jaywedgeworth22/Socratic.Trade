# 2026-08-20 — Web / iOS parity P1+P2 fixes

## Context & Objective

The 2026-08-17 parity audit (`docs/audits/2026-08-17-web-ios-parity.md`, PR #2804) found that push URLs already carry `?proposal=` / `?symbol=` but the website ignored them, iOS dropped the symbol query, and iOS Activity had no Alert Center.  This pass implements the ranked P1 list and the P2 wave.  P3 stays backlog.

## Changes Made

- Website deep links: `/console/approvals?proposal=` scrolls and rings `article#proposal-${id}`; Orders and Watchlist honor `?symbol=` on the first matching row (and Watchlist alert rows).
- iOS: `DeepLinkDestination.symbol` from `?symbol=` on `/console/orders` and `/console/watchlist`; Assets scrolls, rings, and opens the ticker sheet.  Path-only URLs still map to `.tab(.markets)` so the APNs contract stays valid.
- iOS Activity lists snapshot `notifications` (payload/webhook stripped on `/api/mobile/snapshot`).  Unacknowledged `run_failed` / `kill_switch` rows are first and emphasized.
- User-facing **Exit-only** (wire id stays `close_only`) on the web control sheet, toasts, Approvals banner, event-run option, and iOS Home / command labels.
- Lessons uses `CONSOLE_PAGE_WIDTH`.  Watchlist gains `lg:hidden` cards.
- A11y: skip link → `#console-main`; error toasts `role="alert"` / assertive; `TypedConfirm` `htmlFor`/`id`; More `aria-expanded` + `aria-controls`; tab labels 0.75rem; iOS scan star 44×44; swipe `accessibilityAction`.
- Offline banner: “You’re offline.  Showing the last snapshot.”
- Deleted the retired PWA UI tree (`app/mobile/mobile-pwa-client.tsx`, `app/mobile/components/*`, `test/mobile-pwa-client.test.tsx`).  Kept `/mobile` → `/console` and all `/api/mobile/*`.
- Playwright: `mobile-chrome` (iPhone 13 / 390×844) plus skip-link / landmark smoke.  No `@axe-core/playwright` so grandfathered violations cannot fail CI.
- iOS Home hides Exit Only / Wind Down behind **More Postures** when Stop is primary.  Account & Settings links to `/console/connections`.

### Files touched

- `app/console/lib/deep-link-focus.ts` (new)
- `test/console-deep-links.test.ts` (new)
- `test/e2e/console-a11y.spec.ts` (new)
- `app/console/approvals/page.tsx`
- `app/console/components/approval-card.tsx`
- `app/console/orders/page.tsx`
- `app/console/watchlist/page.tsx`
- `app/console/lessons/page.tsx`
- `app/console/components/shell.tsx`
- `app/console/components/chrome.tsx`
- `app/console/components/nav.tsx`
- `app/console/ui/toast.tsx`
- `app/console/lib/useConsoleData.tsx`
- `app/console/console.css`
- `app/console/guardrails/field-defs.ts`
- `app/console/README.md`
- `app/api/mobile/snapshot/route.ts`
- `src/lib/mobile-api.ts`
- `test/mobile-api.test.ts`
- `playwright.config.ts`
- `ios/SocraticTrade/DeepLink.swift`
- `ios/SocraticTradeTests/DeepLinkTests.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/ScanView.swift`
- `docs/mobile-api-and-clients.md`
- `docs/audits/2026-08-17-web-ios-parity.md`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- Deleted: `app/mobile/mobile-pwa-client.tsx`, `app/mobile/components/*`, `test/mobile-pwa-client.test.tsx`

## Decisions & Trade-offs

- Did not add `@axe-core/playwright`.  Landmark + skip-link smoke is the CI bar; a full axe run would fail on the grandfathered backlog.
- Did not extract `mobileRunState` from the deleted PWA client — console already has `derive.ts`.
- Connections handoff is a Safari `Link`, not `ASWebAuthenticationSession`.  The owner is already signed in on the device cookie for universal links; this is the same pattern as Terms / Privacy.
- P3 items (replace-at-market, widgets, wash-sale, Insights rename, AASA `/console/coach`) were left closed.

## Verification State

Commands to run after this note:

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/console-deep-links.test.ts test/mobile-api.test.ts test/pwa-retired-redirect.test.ts
npm test
npm run build
```

iOS `xcodebuild` is not available on this Linux Cloud VM.  Swift changes are compile-shaped to match existing patterns (`DeepLinkDestination` exhaustive switch, optional `notifications` decode).

## Next Steps & Blockers

- Reviewer: confirm a push tap to Approvals / Orders / Watchlist rings the row on the website.
- Next iOS TestFlight should include Activity alerts + symbol focus.
- P3 backlog remains in the audit.

## Zero-Code Findings

None — this pass is implementation.
