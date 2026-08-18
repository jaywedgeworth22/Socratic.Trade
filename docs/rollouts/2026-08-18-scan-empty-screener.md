# 2026-08-18 — iOS Scan empty table is a quote miss

## Context & Objective

Jay's iOS Scan (2026-08-18 ~12:03pm CT, market open) showed "0 names · 2 watched" and "No Candidates. The scan returned no ranked names." Snapshot refresh succeeded. `GET /api/scan` returned 200 with `topCandidates: []` and a `generatedAt`. This was not the Green OpenRouter 404. Watchlist is never the scan universe. A provider miss plus an expired audit seed was masquerading as "no names today."

## Changes Made

A non-empty universe that cannot be priced after the delayed screener, the quote fallback, and a fresh audit seed now throws `ScanQuotesUnavailableError`. `GET /api/scan` returns HTTP 503 with `code: scan_quotes_unavailable`, `scannedSymbols`, `returnedQuotes: 0`, and `warnings`. iOS treats that as a failure banner, not "No Candidates." When the screener is empty, the quote fallback prices the whole allowed set (index members included), not only custom tickers. An actually empty universe still returns 200 with an explicit warning.

- `src/lib/market.ts` — `ScanQuotesUnavailableError`; whole-set quote fallback; empty-universe warning
- `src/lib/yahoo-finance.ts` — optional batch concurrency for the empty-screener fallback
- `app/api/scan/route.ts` — 503 structured body for quote-unavailable
- `app/console/scan/page.tsx` — empty-universe copy (quote miss is now an error)
- `ios/SocraticTrade/DeskModels.swift` — decode `scannedSymbols` / `returnedQuotes` / `warnings`; scan copy helpers
- `ios/SocraticTrade/ScanView.swift` — counts + warnings; no empty card on a failed first load
- `ios/SocraticTradeTests/DeskModelsTests.swift`, `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `test/scan-empty-screener.test.ts`, `test/market-custom-symbol.test.ts`
- `docs/phase-4-market-data-scoring.md`, `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- 503 rather than a 200 "stale last-good" body. Web already keeps the last good scan on error. iOS keeps an in-memory scan if one loaded earlier and now shows the failure banner. First load shows the error, not an empty table.
- Expired seeds stay rejected (`previousTradingDayStart`). A still-valid seed is the stale fallback it already was.
- Empty `includedIndices` with no additional symbols and no holdings is a real empty universe (200 + warning). A non-empty universe with zero quotes is a failure even if the live cause later turns out to be config.
- No coordinator notes in product UI. No Stripe. No OpenRouter spend. Did not stack on #2829 / #2800 / reserved #2792 #2798 #2794.

## Verification State

```bash
npm run lint          # 0 errors (grandfathered warnings only)
npx tsc --noEmit      # clean
npx vitest run test/scan-empty-screener.test.ts test/market-custom-symbol.test.ts \
  test/market-preselection.test.ts test/market-dynamic-universe.test.ts \
  test/scan-singleflight.test.ts
# 28 passed
```

`xcodebuild` is not available on this VM. Swift decode/copy changed; Mac / TestFlight compile is a follow-up. Full `npm test` on this VM hits unrelated env/network flakes (server-metrics, connection-health, history). Focused scan suites are the contract for this PR.

PR **#2830**.

## Next Steps & Blockers

- Compile iOS on a Mac (`xcodebuild` / TestFlight) before claiming the Scan tab visually.
- If production still 503s after deploy, the delayed screener and quote fallback are both down or the universe is non-empty but unpriceable — that is now visible.

## Zero-Code Findings

The 12:03pm CT empty table was consistent with live screener quotes = 0 after allowed-set filter + custom-only Yahoo + expired/missing seed. Watchlist count 2 is `snapshot.watchlist` and never fed `scanMarket`. `#2829` does not touch scan.
