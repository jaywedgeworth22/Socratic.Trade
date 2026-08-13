# Quote sheet Key Stats + fill/position card tap (2026-08-13)

## Context & Objective

Owner opened GOOG from the iOS company sheet and saw price + volume with dashes for P/E, EPS, dividend yield, beta, and the 52-week range.  They also asked why so much data cannot be seen, saved, or updated, and that tapping anywhere on a fill or position card should open trade / position / company details.

## Changes Made

The on-demand `/api/quote` path used the keyless Yahoo **chart** endpoint as a floor (identity, price, volume only) and waited 6 seconds for the full enrichment cascade.  Yahoo quoteSummary (the source of PE/EPS/52w in the cascade) needs a crumb handshake and an 8s HTTP timeout, so the cascade routinely timed out.  The route also never read or wrote `symbol_field_latest`, so previously saved scan fields were invisible and opening a ticker never updated the store.

The route now:

1. Seeds slow fundamentals from `symbol_field_latest` (same store the scan already writes).
2. Maps the 52-week range from chart meta when Yahoo includes it on that same payload.
3. Fetches the keyless v7 quote in parallel for PE/EPS/div/beta/52w (no crumb handshake).
4. Still runs the full cascade inside the 6s budget; live values win when they arrive.
5. Persists the merged record so the next open can show saved fields even if the cascade times out again.

iOS fill and position cards are now full-card buttons.  They open a sheet with fill or position facts plus the same company Key Stats the logo used to open alone.

Touched files:

- `src/lib/yahoo-finance.ts`
- `src/lib/on-demand-quote.ts`
- `app/api/quote/route.ts`
- `test/quote-route.test.ts`
- `test/on-demand-quote.test.ts`
- `test/yahoo-finance-fundamentals.test.ts`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/SymbolInfoSheet.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Kept the chart endpoint as the identity/price floor.  Yahoo sometimes requires a crumb for quoteSummary; the chart path is the one that already works without credentials.
- Added v7 as a third parallel, not a replacement for the cascade.  FMP is still retired/off; Yahoo remains the free floor.
- Dividend yield is converted from Yahoo's fraction to percentage points, matching `YahooFinanceEnrichmentProvider`, so iOS `AppFormat.percent` keeps showing `0.3%` not `0.0%`.
- Durable seed uses `persistedSlowEnrichment` so volatile scan-only fields (sentiment, headlines) are not resurrected into the sheet.
- Store writes stay fire-and-forget, same contract as the cascade.  A persist failure must not fail the quote the user is looking at.
- Fill/position details render even when the quote fetch is still loading or failed.  The trade facts are already on the snapshot; they should not wait on Yahoo.

## Verification State

```bash
npx tsc --noEmit
npx eslint src/lib/yahoo-finance.ts src/lib/on-demand-quote.ts app/api/quote/route.ts test/quote-route.test.ts test/on-demand-quote.test.ts test/yahoo-finance-fundamentals.test.ts
npx vitest run test/quote-route.test.ts test/on-demand-quote.test.ts test/yahoo-finance-fundamentals.test.ts
xcodebuild test -project "Socratic Trade.xcodeproj" -scheme SocraticTrade -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:SocraticTradeTests/MobileModelsTests
```

Focused vitest: 18 passed.  iOS MobileModelsTests: 14 passed, 0 failures (includes `testPresentedMarketItemIdentifiesFillPositionAndCompany`).  Full lint / test / build run via `scripts/land.sh` before the PR.

## Next Steps & Blockers

- After merge, auto-deploy serves the `/api/quote` fix immediately.  iOS card-tap needs a TestFlight ship to reach phones.
- Opening GOOG once after deploy should persist PE/EPS/52w into `symbol_field_latest` for later scans.
- PWA home position rows are still inert (no symbol sheet on that surface).  Out of scope; native iOS was the screenshot.

## Zero-Code Findings

The dashes were not "Yahoo has no GOOG fundamentals."  They were a merge/budget/store miss: the sheet showed the only layer that finished in time (chart price + volume) and threw away everything the scan had already saved.
