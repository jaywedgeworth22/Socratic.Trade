# Phase 2 - Correctness Fixes

## Goals

- Keep reviewed `estimated_notional` as the source of truth for daily notional accounting.
- Count share-quantity market orders correctly even when no limit price is present.
- Attribute sectors for held positions using all available market metadata, not only the top ranked scan rows.
- Allow positions to carry optional `sector` and `industry` metadata from the broker or market scan.

## Interfaces

- `MarketScan.sectorBySymbol`: compact map of every scanned symbol with sector metadata.
- `MarketScan.quotesBySymbol`: compact quote map for symbols returned by the provider.
- `EquityPosition.sector` and `EquityPosition.industry`: optional position metadata.
- `PolicyContext.marketScan`: available to deterministic policy checks.

## Acceptance

- `dailyExecutionStats()` prefers `trade_proposals.estimated_notional`.
- Fallback notional only applies to legacy rows without reviewed notional.
- Sector composition for the LLM and policy enforcement uses position metadata first, then `MarketScan.sectorBySymbol`.
- A held position outside `topCandidates` can still be assigned a sector.
