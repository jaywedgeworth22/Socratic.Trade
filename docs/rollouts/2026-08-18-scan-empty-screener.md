# 2026-08-18 — iOS Scan empty table is the 8s stub-UA abort

## Context & Objective

Coolify SELECT-only receipts on sha `cda485ff`.  Jay's 12:03 CT iOS Scan is audit `market_scan` `d0359642` at 2026-08-18T17:03:07Z: scannedSymbols=505, quotes=0, candidates=0, cached=true, provider `nasdaq-delayed-screener`.  Warnings: "This operation was aborted"; empty stale-fallback claim; "No candidates in this scan — nothing to cover."  Written as `market_scan`, not `market_scan_failed`.  Same abort + 0 quotes on every scan since 2026-08-13T22:30Z.  Last good: `2f2a8e11` 2026-08-13T16:15:45Z (515 / 513 / 65).  Watchlist is XOM + SPCX (2).  505 is S&P-sized, not the 2 watched names.  Not an empty universe.  Not ranker-zero.  Not #2666.  Not #2829.

## Changes Made

Verified abort cause: `fetchNasdaqScreener` `setTimeout(() => controller.abort(), 8000)` with no reason, left armed through `response.json()` of the 8000-row table, UA only `"Mozilla/5.0"`, no Origin/Referer, no `fetchWithRetry`.  Node/undici reports that as “This operation was aborted.”  The 20s interactive deadline uses a different message (“Interactive market scan deadline exceeded.”).  Cache is written only on success, so every scan re-hit and re-aborted.  Sibling nasdaq-calendar + nasdaq-quote already used `BROWSER_UA` + Origin/Referer + `fetchWithRetry({ retries: 1 })` after 2026-08-05 (`docs/rollouts/2026-08-05-soft-health-and-nasdaq-ua.md`).  The screener was never migrated.  `congress-share` `fetchNasdaqScreenerRefs` was the same 8s stub-UA duplicate.

Fix: shared `src/lib/nasdaq-screener-fetch.ts` with `BROWSER_UA` + Origin/Referer + `fetchWithRetry({ retries: 1 })`, 15s named timeout, one abort retry, timer cleared when headers arrive.  Interactive `withScanDeadline` is not attached to the Nasdaq fetch (35s budget covers Yahoo + rank after).  Yahoo-fallback prices the whole allowed set.  Empty `seedEnrichment: {}` no longer 200s `cached=true`.  Both Nasdaq and Yahoo miss → 503 + `market_scan_failed`.  iOS decodes warnings; copy does not blame Guardrails.

- `src/lib/nasdaq-screener-fetch.ts` — shared BROWSER_UA transport (15s, abort retry)
- `src/lib/market.ts` — uses the helper; ignores interactive abort on the screener; Yahoo whole-set; seed only when it prices names
- `src/lib/congress-share.ts` — `fetchNasdaqScreenerRefs` uses the same helper
- `src/lib/scan-singleflight.ts` — `isUnusableEmptyMarketScan` (505 / 0 / 0 is not last-good)
- `src/lib/dashboard.ts` — skip empty abort audits when picking latestScan
- `src/lib/yahoo-finance.ts` — batch concurrency for the empty-screener fallback
- `app/api/scan/route.ts` — 503 + `market_scan_failed`; 35s interactive budget
- `app/console/scan/page.tsx`, `app/console/scan/use-live-scan.ts` — quote-miss copy; 503 warnings
- `ios/SocraticTrade/MobileAPIClient.swift` — decode 503 `scan_quotes_unavailable`
- `ios/SocraticTrade/DeskModels.swift`, `ios/SocraticTrade/ScanView.swift` — counts + warnings; no Guardrails blame
- `ios/SocraticTradeTests/DeskModelsTests.swift`, `ios/SocraticTradeTests/UserFacingCopyTests.swift`
- `test/scan-empty-screener.test.ts`, `test/market-custom-symbol.test.ts`
- `docs/phase-4-market-data-scoring.md`, `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- 15s + one abort retry, not another 8s cut.  8s was the outage.  The interactive deadline is not wired into the Nasdaq fetch so a hang cannot become a silent empty `market_scan`.
- 503 rather than a 200 empty table.  A still-valid seed is the stale fallback it already was; `{}` / expired seed does not claim "showing the latest strategy scan."
- Empty `includedIndices` with no additional symbols and no holdings is a real empty universe (200 + Guardrails).  A 505-symbol abort is not.
- No coordinator notes in product UI.  No Stripe.  No OpenRouter spend.  Did not stack on #2829 / #2800 / reserved #2792 #2798 #2794.

## Verification State

```bash
npx vitest run test/scan-empty-screener.test.ts
npx tsc --noEmit
```

Live recorded 2026-08-18 (market open), this VM:

- Nasdaq screener `BROWSER_UA` + Origin/Referer: HTTP 200, **7176** rows, asOf "Last price as of Aug 18, 2026".
- `scanMarket(SP500_SYMBOLS, [], …, { enrichmentMode: "skip" })`: **498 quotes / 502 scanned / 38 topCandidates**, source `nasdaq-delayed-screener`.  Yahoo fallback was not needed.

`xcodebuild` was not run on this Linux VM.  Do not treat the iOS decode/copy change as compiled.

PR **#2830**.

## Next Steps & Blockers

- Compile iOS on a Mac (`xcodebuild` / TestFlight) before claiming the Scan tab visually.
- After merge, confirm prod writes populated `topCandidates` (or `market_scan_failed` if Nasdaq and Yahoo both miss), never a silent 505/0/0 `market_scan`.

## Zero-Code Findings

Receipt `d0359642` is an in-app 8s stub-UA abort of `nasdaq-delayed-screener` on sha `cda485ff`, then an empty/expired seed, then a successful `market_scan` 200.  iOS never decoded those warnings and told the user to check Guardrails.  `#2666` and `#2829` do not touch this path.
