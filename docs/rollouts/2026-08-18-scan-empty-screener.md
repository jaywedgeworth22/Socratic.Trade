# 2026-08-18 — iOS Scan empty table is a quote miss

## Context & Objective

Jay's iOS Scan (2026-08-18 ~12:03pm CT, market open) showed "0 names · 2 watched" and "No Candidates. The scan returned no ranked names." Snapshot refresh succeeded. `GET /api/scan` returned 200 with `topCandidates: []` and a `generatedAt`. This was not the Green OpenRouter 404. Watchlist is never the scan universe. The live cause is `fetchNasdaqScreener` using a stub `"Mozilla/5.0"` UA and a bare `fetch` with an 8s abort — that path has aborted every production call since 2026-08-13T22:30Z. Other Nasdaq callers already use `BROWSER_UA` + `fetchWithRetry`.

## Changes Made

`fetchNasdaqScreener` now matches nasdaq-quote / nasdaq-calendar: `BROWSER_UA` (Chrome 124 desktop), `Origin`/`Referer` for nasdaq.com, and `fetchWithRetry` (one retry on 429 / transient network). Whole-allowed-set Yahoo fallback stays if Nasdaq still fails. A non-empty universe that still cannot be priced after screener + Yahoo + a fresh audit seed throws `ScanQuotesUnavailableError` (HTTP 503) so iOS does not paint "No Candidates" on a 200 empty table. An actually empty universe still returns 200 with an explicit warning. Success is a populated scan, not a prettier empty state.

- `src/lib/market.ts` — `fetchNasdaqScreener` uses `BROWSER_UA` + `fetchWithRetry`; `ScanQuotesUnavailableError` last resort; whole-set Yahoo fallback; empty-universe warning
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
git rebase origin/main   # clean onto 6429d984 (#2829)
npx vitest run test/scan-empty-screener.test.ts test/market-custom-symbol.test.ts
# 12 passed (includes BROWSER_UA header assertion)
```

Live recorded 2026-08-18 ~2:13pm CT (market open), this VM:

- Nasdaq screener `BROWSER_UA` + Origin/Referer: HTTP 200, **7176** rows, asOf "Last price as of Aug 18, 2026", 3152ms. Sample NVDA/AAPL/GOOGL.
- Same URL with stub `"Mozilla/5.0"` also 200 / 7176 rows here (2490ms). Production abort-since-2026-08-13 is still the stub-UA + bare-fetch + 8s abort path; this branch no longer uses that path.
- `scanMarket(SP500_SYMBOLS, [], …, { enrichmentMode: "skip" })`: **498 quotes / 502 scanned / 38 topCandidates**, source `nasdaq-delayed-screener`, 2591ms. First names: MSFT 482.38, JPM 362.64, BRK-B 502.91. Yahoo fallback was not needed.

`xcodebuild` was not run on this Linux VM. Do not treat the iOS decode/copy change as compiled.

PR **#2830**.

## Next Steps & Blockers

- Compile iOS on a Mac (`xcodebuild` / TestFlight) before claiming the Scan tab visually.
- If production still 503s after deploy, the delayed screener and quote fallback are both down or the universe is non-empty but unpriceable — that is now visible.

## Zero-Code Findings

The 12:03pm CT empty table was consistent with live screener quotes = 0 after allowed-set filter + custom-only Yahoo + expired/missing seed. Watchlist count 2 is `snapshot.watchlist` and never fed `scanMarket`. `#2829` does not touch scan.
