# Codex Review: strategy dedup enrichment wiring fixes

## Summary

Addressed two P2 Codex review findings on PR #1482 (`agent/ag-dedup-types`):

1. **Evidence age anomaly dedup ordering** (`src/lib/strategy.ts`): The LRU dedup cache was running AFTER `collectEvidenceAgeAnomalies`'s 12-item cap, so stale cached items could fill all 12 slots and suppress fresh anomalies. Moved the dedup to filter `evidenceAgeInputs` BEFORE the cap, so already-audited items never consume receipt slots and fresh items beyond the stale 12 still reach the audit.

2. **Missing enrichment path for new quote metrics** (`src/lib/data-providers.ts`, `src/lib/market.ts`, `src/lib/types.ts`): The PR added 10 new optional fields to `MarketQuote`/`MarketQuoteSummary` (`returnOnEquity`, `returnOnAssets`, `revenueGrowth`, `freeCashFlowYield`, `grossProfitMargin`, `congressTradesQuiver`, `insiderTradesQuiver`, `govContractsQuiver`, `lobbyingQuiver`, `patentsQuiver`) but did not wire them through the per-field enrichment cascade. Added:
   - Field declarations to `SymbolEnrichment` interface
   - Literal entries to `EnrichmentSourcedField` union
   - `takeScalar(...)` calls in `CascadingEnrichmentProvider.enrich`
   - Entries in `EMPTY_SOURCED` marker map
   - `??` overrides in `applyEnrichment`
   - Mappings in `quotesBySymbol`
   - Field names in `EnrichmentSources` type

## Why

Codex autofix pass: both findings are correctness issues that would cause silent data loss (missed anomaly audits, dropped enrichment values).

## Files

- `src/lib/strategy.ts` — moved LRU dedup before `collectEvidenceAgeAnomalies` cap
- `src/lib/data-providers.ts` — SymbolEnrichment fields, EnrichmentSourcedField, takeScalar calls, EMPTY_SOURCED entries
- `src/lib/market.ts` — applyEnrichment overrides, quotesBySymbol mappings
- `src/lib/types.ts` — EnrichmentSources field list
- `docs/rollouts/2026-07-12-codex-review-strategy-dedup.md` — this note

## Verification

```bash
npm run lint       # 0 errors (427 warnings — grandfathered)
npx tsc --noEmit   # clean
npm test           # 349 files, 3896 tests passed
npm run build      # clean production build
```

## Follow-ups

- None. Both Codex threads should be resolved.
