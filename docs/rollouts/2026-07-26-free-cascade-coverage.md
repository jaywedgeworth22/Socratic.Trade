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
npx vitest run test/enrichment-coverage.test.ts test/enrichment-scarce-tier-gate.test.ts test/market.test.ts
# (full lint/tsc/test/build run before PR claim)
```

## Next Steps & Blockers

- After a production scan, open Admin → Enrichment Coverage (or ops snapshot
  `enrichmentCoverage`) to inspect live fill/source/missing.
- Optional follow-up: expand keyless SEC XBRL beyond debtToEquity; persist coverage
  history across restarts if desired.
