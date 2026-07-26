# 2026-07-26 — Free-first enrichment cascade + coverage report

## Context & Objective

Ensure the market-data enrichment cascade prefers free/keyless and RapidAPI failover
sources, recovers from transient free-tier failures, and gives the owner a clear view of
which data points filled, which source won (or won most often), and which fields remain
missing — without depending on paid native keys.

## Changes Made

- **Free-first field-demand planner** (default ON via `ENRICHMENT_FREE_FIRST_ENABLED`):
  - Wave A: free/keyless providers (`costTier !== "paid"`) over the full batch, with one
    retry when a free provider throws.
  - Wave B: paid non-scarce providers only for symbols still missing core gap fields
    (with `coveredFields` hint).
  - Wave C: existing scarce RapidAPI gate for `suppliesFields` gaps.
- **RapidAPI gating fixes:** `insiders-rapidapi` and `twelvedata-rapidapi` now declare
  `suppliesFields` so they actually enter wave C instead of burning quota in wave A.
- **Coverage report:** `src/lib/enrichment-coverage.ts` aggregates fill rates, winning
  sources, missing fields, and provider failures after each cascade run.
- **Surfaces:** Admin page `/admin/enrichment-coverage`, API
  `/api/admin/enrichment-coverage`, and a compact `enrichmentCoverage` block on the ops
  snapshot.
- **Provenance continuity:** `applyEnrichment` now carries `fieldObservations` and
  `providerFailures` onto `MarketQuote`.

### Files touched

- `src/lib/data-providers.ts`
- `src/lib/enrichment-coverage.ts` (new)
- `src/lib/market.ts`
- `src/lib/ops-snapshot.ts`
- `app/api/admin/enrichment-coverage/route.ts` (new)
- `app/admin/enrichment-coverage/*` (new)
- `app/admin/layout.tsx`
- `test/enrichment-coverage.test.ts` (new)
- `test/market.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/rollouts/2026-07-26-free-cascade-coverage.md` (this file)

## Decisions & Trade-offs

- Paid-wave gap detection uses a **core** field set (quotes/fundamentals/sentiment), not
  specialty Quiver/options/target fields — otherwise every symbol would always look
  incomplete and paid lanes would never skip.
- Free-first is default ON; set `ENRICHMENT_FREE_FIRST_ENABLED=0` to restore the legacy
  single concurrent non-scarce wave.
- Coverage report is in-memory (last cascade run only) — sufficient for ops/admin after a
  scan; not a durable time series.
- SEC XBRL and Webull remain opt-in (rate/ToS considerations); Yahoo + Alpaca + RapidAPI
  remain the primary no-paid-native-key path.

## Verification State

```bash
npm run lint                 # 0 errors
npx tsc --noEmit             # pass
npx vitest run test/enrichment-coverage.test.ts test/enrichment-scarce-tier-gate.test.ts \
  test/rapidapi-providers.test.ts test/nasdaq-quote-enrichment.test.ts
# full npm test + npm run build before merge claim
```

## Follow-up (same branch) — more free/RapidAPI robustness

### Changes Made
- **Alpha Vantage RapidAPI** now also calls `NEWS_SENTIMENT` when sentiment/headlines
  are still gaps (`parseAlphaVantageNewsSentiment`); OVERVIEW skipped when fundamentals
  already covered.
- **ROIC.ai** wired into `API_KEY_ENV_MAP` (`ROIC_API_KEY`, shared-operator-infra) so the
  env key actually registers; profile parser maps snake_case fields; ratios stay best-effort
  (paths still 404 on current free plan).
- **Keyless Nasdaq quote enrichment** (`nasdaq-quote`): public
  `/api/quote/{sym}/info|summary` + institutional-holdings — free-wave redundancy beside Yahoo.
- Docs/env example updated; owner asked to subscribe additional RapidAPI free products
  (see Next Steps).

### Additional files touched
- `src/lib/db-api-keys.ts`
- `src/lib/provider-rate-limit.ts`
- `test/nasdaq-quote-enrichment.test.ts` (new)
- `test/rapidapi-providers.test.ts`
- `.env.example`

## Follow-up 2 — FilingAPI.dev + SEC XBRL default ON + more RapidAPI lanes

### Changes Made
- **SEC XBRL default ON** (unset → enabled; set `0`/`off` to disable).
- **FilingAPI.dev** via `FILINGAPI` / `FILINGAPI_KEY`: `/v1/company`, earnings calendar,
  insider summary (scarce wave-C; ~50/day free tier).
- **RapidAPI lanes:** `yh-finance-apidojo`, `real-time-finance-data`, `seeking-alpha-rapidapi`.
  Live probe: real-time-finance-data = 200; yh-finance + seeking-alpha still 403
  not-subscribed on current `RAPIDAPI_KEY` until Pricing → Subscribe shows Active.

### Owner — Pricing / Subscribe links (use these — NOT the API overview tabs)
Open each URL, pick the **Basic/Free** plan, click **Subscribe**, confirm the RapidAPI
**Apps** dropdown is the same app that owns production `RAPIDAPI_KEY` (Connections shows
masked preview). Overview/Endpoints tabs do not subscribe you.

1. Yahoo Finance (API Dojo) — **Subscribe here**:
   https://rapidapi.com/apidojo/api/yh-finance/pricing
2. Real-Time Finance Data — **Subscribe here** (this one already returns 200 on cloud key):
   https://rapidapi.com/letscrape-6bRBa3Qgu/api/real-time-finance-data/pricing
   (alt listing: https://rapidapi.com/s.mahmoud97/api/real-time-finance-data/pricing)
3. Seeking Alpha (API Dojo) — **Subscribe here**:
   https://rapidapi.com/apidojo/api/seeking-alpha/pricing
4. Stock Market Data (optional; skip if you cannot find it — not required):
   https://rapidapi.com/fyhao/api/stock-market-data/pricing
   Search on RapidAPI for publisher **fyhao** / API name **Stock Market Data** if that URL 404s.

Re-probe after owner signup (2026-07-26, cloud key `dbb6a14c…ff66`): #2 OK; #1/#3/#4 still 403.

### Additional files
- `src/lib/db-api-keys.ts`, `src/lib/rapidapi-quota.ts`, `src/lib/provider-rate-limit.ts`
- `test/filingapi-and-new-rapidapi.test.ts`, `test/sec-xbrl.test.ts`, `test/data-providers.test.ts`

## Next Steps & Blockers

- Confirm RapidAPI dashboard shows **Active** for yh-finance + seeking-alpha on the same
  app key as prod `RAPIDAPI_KEY` (RT finance already works).
- After a production scan, check Admin → Enrichment Coverage / ops `enrichmentCoverage`.
- Optional: expand SEC XBRL beyond D/E; persist coverage history.
