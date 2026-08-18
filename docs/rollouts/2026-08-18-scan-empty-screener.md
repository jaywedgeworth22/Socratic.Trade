# 2026-08-18 — iOS Scan empty table is a quote miss

## Context & Objective

Coolify SELECT-only receipts on sha `cda485ff`.  Jay's 12:03 CT iOS Scan is audit `market_scan` `d0359642` at 2026-08-18T17:03:07Z: scannedSymbols=505, quotes=0, candidates=0, cached=true, provider `nasdaq-delayed-screener`.  Warnings: "This operation was aborted"; empty stale-fallback claim; "No candidates in this scan — nothing to cover."  Written as `market_scan`, not `market_scan_failed`.  Same abort + 0 quotes on every scan since 2026-08-13T22:30Z.  Last good: `2f2a8e11` 2026-08-13T16:15:45Z (515 / 513 / 65).  Watchlist is XOM + SPCX (2).  505 is S&P-sized, not the 2 watched names.  Not an empty universe.  Not ranker-zero.  Not #2829.

## Changes Made

`fetchNasdaqScreener` uses `BROWSER_UA` + `fetchWithRetry`.  Yahoo whole-set fallback if Nasdaq still fails.  Abort / 0-quotes on a non-empty universe is HTTP 503 + `market_scan_failed`, not a silent 200 `market_scan`.  Empty abort rows are not last-good.  iOS decodes the 503 body so warnings + scanned/quotes counts show; copy does not blame Guardrails or the watchlist.

- `src/lib/market.ts` — `BROWSER_UA` + `fetchWithRetry`; seed only when it actually prices names; 503 last resort
- `src/lib/scan-singleflight.ts` — `isUnusableEmptyMarketScan` (505 / 0 / 0 is not last-good)
- `src/lib/dashboard.ts` — skip empty abort audits when picking latestScan
- `src/lib/yahoo-finance.ts` — batch concurrency for the empty-screener fallback
- `app/api/scan/route.ts` — 503 + `market_scan_failed`
- `app/console/scan/page.tsx`, `app/console/scan/use-live-scan.ts` — quote-miss copy; 503 warnings; drop unusable empty last-good
- `ios/SocraticTrade/MobileAPIClient.swift` — decode 503 `scan_quotes_unavailable`
- `ios/SocraticTrade/DeskModels.swift`, `ios/SocraticTrade/ScanView.swift` — counts + warnings; no Guardrails blame on a 505-symbol quote miss
- `ios/SocraticTradeTests/DeskModelsTests.swift`, `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `test/scan-empty-screener.test.ts`, `test/market-custom-symbol.test.ts`
- `docs/phase-4-market-data-scoring.md`, `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- 503 rather than a 200 empty table.  A still-valid seed is the stale fallback it already was; an empty seed does not claim "showing the latest strategy scan."
- Expired seeds stay rejected (`previousTradingDayStart`).  Last good `2f2a8e11` is older than that window, so it cannot silently 200 as today's table.
- Empty `includedIndices` with no additional symbols and no holdings is a real empty universe (200 + Guardrails).  A 505-symbol abort is not.
- No coordinator notes in product UI.  No Stripe.  No OpenRouter spend.  Did not stack on #2829 / #2800 / reserved #2792 #2798 #2794.

## Verification State

```bash
git rebase origin/main   # clean onto 6429d984 (#2829)
npx vitest run test/scan-empty-screener.test.ts test/market-custom-symbol.test.ts
# 16 passed (abort receipt + BROWSER_UA + 503 market_scan_failed)
npx tsc --noEmit  # clean
```

Live recorded 2026-08-18 (market open), this VM:

- Nasdaq screener `BROWSER_UA` + Origin/Referer: HTTP 200, **7176** rows, asOf "Last price as of Aug 18, 2026".
- `scanMarket(SP500_SYMBOLS, [], …, { enrichmentMode: "skip" })`: **498 quotes / 502 scanned / 38 topCandidates**, source `nasdaq-delayed-screener`.  Yahoo fallback was not needed.

`xcodebuild` was not run on this Linux VM.  Do not treat the iOS decode/copy change as compiled.

PR **#2830**.

## Next Steps & Blockers

- Compile iOS on a Mac (`xcodebuild` / TestFlight) before claiming the Scan tab visually.
- After merge, confirm prod writes `market_scan_failed` on abort and a populated scan when Nasdaq answers.

## Zero-Code Findings

Receipt `d0359642` is an in-app 8s abort of `nasdaq-delayed-screener` (stub UA + bare fetch on sha `cda485ff`), then an empty/expired seed, then a successful `market_scan` 200.  iOS never decoded those warnings and told the user to check Guardrails.  `#2829` does not touch scan.
