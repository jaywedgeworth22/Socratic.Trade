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

## Next Steps & Blockers

- After a production scan, open Admin → Enrichment Coverage (or ops snapshot
  `enrichmentCoverage`) to inspect live fill/source/missing.
- **Owner action — RapidAPI free subscriptions to reach 8+ wired hosts** (agent cannot
  create keys; use existing `RAPIDAPI_KEY` after Subscribe):
  1. **Yahoo Finance** by API Dojo — `yh-finance.p.rapidapi.com` (or `apidojo-yahoo-finance-v1`)
  2. **Real-Time Finance Data** — `real-time-finance-data.p.rapidapi.com`
  3. **Seeking Alpha** — `seeking-alpha.p.rapidapi.com` (if free tier still exists)
  4. **Stock Market Data** — `stock-market-data.p.rapidapi.com`
  5. Clarify/fix **FilingAPI / FundamentalsAPI**: cloud secret `FILINGAPI` does not auth
     `fundamentalsapi.com`; RapidAPI host `filing-api.p.rapidapi.com` looks subscribed but
     returns gateway 404/429 — need the correct product URL + working free plan.
  6. Optional: re-check **yahoo-finance-api.p.rapidapi.com** (subscribed but gateway 500s).
- Optional: enable `SEC_XBRL_ENRICHMENT_ENABLED=1` in prod for authoritative debt/equity;
  expand XBRL beyond D/E; persist coverage history across restarts.
