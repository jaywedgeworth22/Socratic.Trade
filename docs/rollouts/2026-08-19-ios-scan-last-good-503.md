# 2026-08-19 — iOS Scan keeps last-good on a 503 refresh

## Context & Objective

Jay's signed-in web `/console/scan` on live `4abfb7fa` clicked Refresh scan once (not Run once).  Fresh refresh showed “Market scan failed (503). Showing the last good scan from Aug 18, 2026, 7:25:13 PM.”  The fallback cache still had the universe: Market scan (70), Smart money (20), 5069 quotes / 50 ranked + 5 held + 15 outliers / 5073 scanned, names including BRK-B / GOOG / BRK-A.  Testers on TestFlight 1.0.68 (#2830 ScanView) still saw iOS Market Scan as empty or broken.  iOS is a different surface and did not keep last-good.

## Changes Made

Live 503 reason: after an empty Nasdaq screener, interactive `/api/scan` Yahoo-priced the whole allowed set (~5073 names, concurrency 4).  That cannot finish inside the 35s budget, and the request often dies as generic 503 HTML (web copy `Market scan failed (503).` is the no-JSON fallback).  The last-good seed web already shows was applied only after that Yahoo work.  `marketScanQuotesFromAudit` also used all-or-nothing validation, so one bad row in a 5k map voided the seed.

iOS only called `GET /api/scan`.  `/api/mobile/snapshot` had no `latestScan`.  A 503 body with `topCandidates: []` replaced any in-memory table.  The client timeout was 25s vs a 35s server budget.

- `src/lib/market.ts` — `recoverQuotesWhenScreenerEmpty` uses last-good seed before Yahoo whole-set
- `src/lib/scan-singleflight.ts` — keep valid `quotesBySymbol` rows
- `src/lib/mobile-scan.ts` — compact last-good scan (names + counts; no 5k map)
- `app/api/mobile/snapshot/route.ts` — emit `latestScan`
- `app/api/scan/route.ts` — comment matches seed-first order
- `ios/SocraticTrade/MobileModels.swift` — decode optional `latestScan`
- `ios/SocraticTrade/DeskModels.swift` — `keepingLastGood` + last-good banner copy
- `ios/SocraticTrade/ScanView.swift` — seed from snapshot; keep names on failed refresh
- `ios/SocraticTrade/MobileAPIClient.swift` — 50s client wait
- `ios/SocraticTradeTests/DeskModelsTests.swift`, `MobileModelsTests.swift`, `UserFacingCopyTests.swift`
- `test/scan-empty-screener.test.ts`, `test/scan-singleflight.test.ts`, `test/mobile-scan.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/phase-4-market-data-scoring.md`

## Decisions & Trade-offs

- Last-good on iOS is the same dashboard seed web already paints.  A 505/0/0 abort is still not last-good.
- Snapshot sends ranked names only.  The 5k `quotesBySymbol` map is too large for the mobile snapshot.
- iOS banner names the miss in ordinary language and appends the last-good stamp.  It does not print `503`.
- Client wait is 50s so a late 200/seed is not dropped while the server is still inside 35s.
- Yahoo whole-set remains when there is no usable seed (existing empty-screener tests).
- Did not merge, deploy, bounce Coolify, start a second TestFlight, click Manual Run, or touch #2848 / #2849 / #2841 / #2840.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/scan-empty-screener.test.ts test/scan-singleflight.test.ts test/mobile-scan.test.ts
# 28 passed
```

Linux VM cannot compile Swift.  No TestFlight.  Full `npm test` + `npm run build` running after this note.

## Next Steps & Blockers

Do not merge from this seat.  After verify is green, owner can land.  Testers still on TF 1.0.68 until a later ship that includes this iOS ScanView change.

## Zero-Code Findings

Public unauthenticated `GET /api/scan` is 401 (session required).  That is expected and is not the iOS break.  Web last-good proved the seed exists; iOS never received it.
