# Congress.Trade Integration Rollout

## Summary
Updated `.env.example` to fix the `CONGRESS_TRADE_AUTOFORWARD` to `CONGRESS_SHARE_ENABLED` variable mismatch, reflecting the true environment variable name used in the codebase.
Prepared Infisical flag changes to enable the bidirectional Congress.Trade (App A) <-> Socratic.Trade (App B) integration.

### Autofix Round 2
Addressed 4 additional Codex P2 threads:
- **EFFORT-LOG.md completeness** — added missing `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` variable and stream subscription prerequisites (`CONGRESS_STREAM_SUBSCRIPTION_ID`+`_TOKEN` or `CONGRESS_STREAM_AUTO_SUBSCRIBE`) to the effort row.
- **Files touched** — updated rollout doc to list all 4 files changed, not just `.env.example`.
- **Verification commands** — replaced narrative verification with actual `tsc --noEmit` / `npm test` / `npm run build` commands run and their results.
- **Price mode ordering** — moved price-adjustment resolution to step 1 of the follow-up list (before `CONGRESS_SHARE_ENABLED`), because the nightly share job activates with the flag and would seed wrong prices without the price-mode decision settled.

## Why
App B already contained the infrastructure to share (EOD, insider, etc.) and consume (congress trades, scores, analytics) data from App A, but they were gated behind feature flags. The goal of this rollout is to turn these flags on in the production environment. We also fixed a documentation mismatch in `.env.example`.

## Files Touched
- `.env.example`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-13-congress-trade-integration.md` (this file)

## Verification
Three required gates (all passed):
```bash
npx tsc --noEmit
npm test
npm run build
```
- `npm run lint` was skipped for this purely doc/env change (no product source touched).

## Follow-ups
1. **Price Adjustments:** Resolve the outstanding price-adjustment discrepancy between App A (FMP-adjusted closes) and App B (raw closes) before enabling any flags that trigger automatic data sharing. The current data plan (`docs/congress-trade-data-plan.md`) marks this as a prerequisite: mixing adjusted and raw closes corrupts return math across splits/dividends. Decide whether to consume App A's adjusted data as-is, apply a fallback, or use a dedicated import mode that avoids the mismatch. **This must be resolved first** because `CONGRESS_SHARE_ENABLED` activates the nightly scheduler that posts closes to App A — running it with unresolved price modes seeds wrong prices through the automatic path, not just the explicit backfill.
2. **Infisical Updates:** Once the price-adjustment decision is settled, the owner must manually set the following variables to `on` in Infisical:
   - `CONGRESS_SHARE_ENABLED`
   - `CONGRESS_TRADE_READS_ENABLED`
   - `CONGRESS_TRADE_AS_CONGRESS_SOURCE`
   - `CONGRESS_ANALYTICS_ENABLED`
   - `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` (ensure App A PR #46 is merged first)
   - `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` (also requires App A PR #46 — enables fundamentals/analyst in the outbound scan-hook push; without this, `shareScanRefs` skips the fundamentals/analyst arrays even when the share master switch is on)
   - `ENRICHMENT_SHORT_CIRCUIT_ENABLED`
   - `CONGRESS_STREAM_ENABLED`
   - For the stream to actually work, one of the following subscription pre-requisites must also be configured:
     - Set `CONGRESS_STREAM_SUBSCRIPTION_ID` + `CONGRESS_STREAM_SUBSCRIPTION_TOKEN` (e.g. a pre-arranged webhook secret pair), **or**
     - Set `CONGRESS_STREAM_AUTO_SUBSCRIBE=on` to auto-discover via the App A API.
     Without one of these, `resolveSubscription` returns null and the stream never activates.
3. **Backfill:** Once the flags are flipped, seed App A's database. Note that `POST /api/admin/congress-share {"fullHistory": true}` only backfills `collectMonitoredSymbols()` (the app's monitored universe), which may miss some congressional tickers not in the watchlist. For full coverage, specify an explicit `symbols` array or pass `"allIndexes": true` to also include major-index members:
