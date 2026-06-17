# Phase 4 - Market Data And Multi-Factor Scoring

## Goals

- Introduce a provider abstraction without removing the current delayed Nasdaq fallback.
- Add Robinhood bid/ask quote enrichment when the adapter supports it.
- Cache market scans and quotes with TTLs to reduce latency and rate-limit risk.
- Replace single-score ranking with configurable factor scores.

## Provider Shape

- `MarketDataProvider.scan(symbols, positions, options)`: normalized scan output.
- `MarketQuote` includes provider, freshness, bid, ask, factor breakdown, sector, industry, and score.
- Optional provider data for fundamentals, technicals, and news/sentiment can be added later without changing strategy logic.

## Scoring Factors

- Liquidity
- Momentum
- Value
- Quality
- Volatility
- Sentiment
- Diversification

Weights are normalized before scoring. Missing provider data uses neutral factor values instead of failing the scan.

**Sub-factor enrichment (2026-06-16, branch `ui-redesign`):** the Value and
Quality sub-scores now incorporate previously-orphaned fundamentals that the
enrichment cascade was already fetching:

- **Value** adds a free-cash-flow-yield adjustment (`fcfYield >= 6% -> +12`,
  `>= 3% -> +6`, `< 0 -> -8`) on top of the P/E or market-cap base.
- **Quality** adds leverage (normalized `debtToEquity <= 0.5 -> +10`,
  `<= 1.5 -> +3`, `> 3 -> -10`) and earnings-growth (`epsGrowth >= 15% -> +8`,
  `> 0 -> +3`, `< -10% -> -8`) adjustments.

Both clamp to 0-100. The Market Scan table surfaces these as FCF% / D/E / EPS gr
columns with source-attribution tooltips; cells show `-` when no provider
supplied the value (never a fabricated number). See
`docs/rollouts/2026-06-16-signals-learning.md`.

## Acceptance

- Scan results include `factorBreakdown` for each candidate.
- `MarketScan.sectorBySymbol` and `quotesBySymbol` cover all returned quotes.
- Nasdaq delayed data is still available as fallback.
- Robinhood quote enrichment adds bid/ask where available and does not fail the run when unsupported.
- The strategy prompt asks for ask-relative limit prices only when ask data exists.
