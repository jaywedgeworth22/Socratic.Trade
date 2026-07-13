# Congress.Trade Integration Rollout

## Summary
Updated `.env.example` to fix the `CONGRESS_TRADE_AUTOFORWARD` to `CONGRESS_SHARE_ENABLED` variable mismatch, reflecting the true environment variable name used in the codebase.
Prepared Infisical flag changes to enable the bidirectional Congress.Trade (App A) <-> Socratic.Trade (App B) integration.

## Why
App B already contained the infrastructure to share (EOD, insider, etc.) and consume (congress trades, scores, analytics) data from App A, but they were gated behind feature flags. The goal of this rollout is to turn these flags on in the production environment. We also fixed a documentation mismatch in `.env.example`.

## Files Touched
- `.env.example`

## Verification
- Checked `infisical` CLI version and identified missing permissions/project context for autonomous secret injection.
- Verified that the source code accurately checks for `CONGRESS_SHARE_ENABLED` rather than the old documented name.

## Follow-ups
1. **Infisical Updates:** The owner must manually set the following variables to `on` in Infisical:
   - `CONGRESS_SHARE_ENABLED`
   - `CONGRESS_TRADE_READS_ENABLED`
   - `CONGRESS_TRADE_AS_CONGRESS_SOURCE`
   - `CONGRESS_ANALYTICS_ENABLED`
   - `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` (ensure App A PR #46 is merged first)
   - `ENRICHMENT_SHORT_CIRCUIT_ENABLED`
   - `CONGRESS_STREAM_ENABLED`
2. **Backfill:** Once the flags are flipped, the owner needs to execute the `fullHistory` backfill to seed App A's database: `POST /api/admin/congress-share {"fullHistory": true}`.
3. **Price Adjustments:** Address the outstanding price-adjustment discrepancy between App A (FMP-adjusted closes) and App B (raw closes) before relying heavily on shared analytics.
