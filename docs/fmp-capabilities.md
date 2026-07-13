# Financial Modeling Prep (FMP) Capabilities Audit

This is a living artifact documenting the capabilities of the Financial Modeling Prep (FMP) API, what we currently use in the Socratic.Trade enrichment cascade, and what we explicitly do not use.

## Comprehensive API Categories

The Financial Modeling Prep API offers a broad ecosystem of financial data organized into several key categories:

1. **Company Information**
   - Company Profiles, Peers, Search, CIK/CUSIP/ISIN searches, and executive rosters.
2. **Financial Statements**
   - As-reported and standardized Income Statements, Balance Sheets, and Cash Flow Statements (annual and quarterly).
3. **Financial Metrics & Ratios**
   - Key investment ratios, enterprise values, and financial growth metrics.
4. **Market Data**
   - Real-time stock quotes, after-market quotes, historical price data (daily/intraday), indexes, and market snapshots.
5. **Analyst Estimates**
   - Price targets, analyst recommendations, consensus data, and earnings estimates.
6. **Stock Calendars**
   - Earnings calendars, IPOs, stock splits, and dividend announcements.
7. **Alternative Assets**
   - Forex, cryptocurrency, and commodities data.
8. **Regulatory & News**
   - SEC filings (8-K, 10-K, etc.), earnings call transcripts, and general stock news/sentiment.
9. **Institutional & Insider**
   - Senate trading and Insider trading data.

## What We Currently Use

As of the current implementation in `src/lib/data-providers.ts` (`FmpEnrichmentProvider`), we actively fetch the following endpoints for our fundamentals cascade:

- **`/stable/ratios-ttm`**: Sourcing the Trailing Twelve Months (TTM) P/E ratio (`peRatio`).
- **`/stable/grades-consensus`**: Sourcing the analyst rating (`analystRating`, `analystScore`) and buy/hold/sell counts.
- **`/api/v4/insider-trading`**: Sourcing insider sentiment by aggregating recent insider buys vs. sells (`insiderSentiment`).
- **`/api/v4/senate-trading`**: Sourcing congressional/senate trading activity (`senateTrades`).
- **`/stable/price-target-consensus`**: Sourcing analyst price targets (`targetMean`, `targetHigh`, `targetLow`, `targetMedian`). *Note: This is an opt-in fetch gated by the `FMP_PRICE_TARGETS_ENABLED` flag.*
- **`/v3/key-metrics-ttm`** & **`/v3/financial-growth`**: Used for expanding fundamental metrics (recently added as part of the Quiver Quant/FMP expansion).

*Note: The FMP fetch skips redundant sub-calls (like P/E and consensus) if a free upstream provider (like App A / congress.trade) has already supplied a fresh value.*

## What We Explicitly DO NOT Use

To optimize costs, latency, and rely on preferred primary providers, we deliberately skip or do not use the following FMP categories:

- **Market Data (Quotes/Prices)**: We do not use FMP for real-time prices or historical pricing. Instead, we use Alpaca for real-time Tier-1 snapshots and Webull/Yahoo Finance for delayed quotes.
- **News & Sentiment**: We do not use FMP for news. The system explicitly notes that FMP contributes no news sentiment (we rely on Finnhub, Alpaca, and Yahoo Finance for headlines and tone).
- **Company Profile / Sector / Industry**: We do not use FMP for basic categorization. We use Yahoo Finance and Finnhub to determine a company's sector and industry.
- **Financial Statements / EPS**: We do not use FMP for raw statements or EPS. Yahoo Finance provides EPS, Dividend Yield, and beta. SEC XBRL is used for debt-to-equity ratios.
- **Short Interest**: FMP does not offer a native short-interest endpoint. We rely on Yahoo Finance and Massive REST for short percent of float and disagreement cross-checks.
