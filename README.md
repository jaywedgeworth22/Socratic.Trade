# Robinhood Agentic Trading Dashboard

Local-only Next.js dashboard for managing a Robinhood agentic account through MCP.

## What It Does

- Shows accounts, portfolio, positions, orders, and an audit feed.
- Runs an equity strategy loop in either proposal-only or decision mode.
- Scans the allowed equity universe with delayed quote data before asking the LLM for proposals.
- Lets an LLM propose trades, then enforces deterministic policy gates before live order placement.
- Reviews every order with Robinhood before placement.
- Uses idempotency keys for live order placement.
- Defaults to mock Robinhood data and Paper mode.

## Safety Defaults

- Equity execution only.
- Allowlist required before autonomy can be enabled.
- Allowlist can be either a custom ticker list or the built-in S&P 500 universe.
- Max `$10` per order.
- Max `$500` daily notional.
- Max `25%` portfolio exposure per symbol.
- Max `10` live orders per day.
- Kill switch blocks new orders immediately.

## Allowed Universe

Use **Allowed Universe** in the dashboard controls:

- `Custom allowlist` lets you type comma- or space-separated tickers and saves on blur or Enter.
- `S&P 500` allows all locally generated S&P 500 constituent symbols from Wikipedia's constituents table fetched on 2026-06-14.

The S&P 500 universe is stored locally in `src/lib/sp500.ts`; the app does not fetch constituents at runtime.

## Strategy Authority

Use **Strategy Authority** in the dashboard controls:

- `LLM proposes` records reviewed recommendations but does not submit orders, even when live mode is on.
- `LLM decides` uses the existing autonomous path: policy gate, Robinhood review, then Paper or Live placement depending on mode.

## Setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini        # or gpt-4o for deeper reasoning
OPENAI_API_URL=...               # optional: override to use an OpenAI-compatible endpoint
ROBINHOOD_ADAPTER=mock           # "mock" (default) or "mcp" for real Robinhood MCP
DATABASE_URL=file:./data/app.db
MARKET_SCAN_LIMIT=30
MARKET_SCAN_CACHE_TTL_MS=300000

# Optional: fundamentals + analyst enrichment (Finnhub).
# Provides P/E, EPS, dividend yield, analyst ratings, and news sentiment per symbol.
# Without a key the scan falls back to neutral defaults and built-in mock metrics
# for well-known tickers (AAPL, MSFT, NVDA, etc.) so Paper runs still show real-looking data.
FINNHUB_API_KEY=...

# Optional: Financial Modeling Prep (legacy FMP fallback; Finnhub is preferred).
FMP_API_KEY=...
FMP_MAX_SYMBOLS=15               # cap enriched candidates per scan (free-tier quota friendly)
NEWS_CACHE_TTL_MS=21600000       # enrichment cache TTL (default 6h)

# Optional: macroeconomic context injected into LLM prompt (Federal Reserve FRED API).
# Adds fed funds rate, 10-yr treasury yield, CPI, and unemployment rate to strategy context.
# Without a key the prompt uses hardcoded recent defaults (updated periodically in macro.ts).
FRED_API_KEY=...

# Optional: webhook for trade notifications.
# Discord webhook URLs receive rich embeds; any other URL receives generic JSON.
WEBHOOK_URL=...
```

## Paper vs Live

- **Paper mode** is a standalone simulation: it starts from a configurable paper cash
  balance (`Paper start ($)` in the Risk panel, default `$10,000`), applies simulated
  fills, and marks open positions to the same live prices Live uses. Paper trades feed
  back into later decisions, so the simulated account evolves the way a live one would.
- **Live mode** places real orders through the broker adapter.
- Both modes use the identical market-data path (NASDAQ screener + broker quotes +
  Finnhub enrichment when `FINNHUB_API_KEY` is set).

To use a real MCP transport, set:

```bash
ROBINHOOD_ADAPTER=mcp
ROBINHOOD_MCP_URL=https://your-robinhood-mcp-server/mcp
ROBINHOOD_MCP_AUTH_TOKEN=...
```

The adapter calls MCP `tools/call` using JSON-RPC.

For hosted MCP servers that require OAuth instead of a static bearer token, leave
`ROBINHOOD_MCP_AUTH_TOKEN` empty and configure:

```bash
ROBINHOOD_MCP_AUTHORIZATION_URL=https://...
ROBINHOOD_MCP_TOKEN_URL=https://...
ROBINHOOD_MCP_CLIENT_ID=...
ROBINHOOD_MCP_CLIENT_SECRET=... # only when required by the provider
ROBINHOOD_MCP_REDIRECT_URI=http://localhost:3000/api/auth/robinhood/callback
ROBINHOOD_MCP_SCOPES=tools:call
```

If the provider supports dynamic client registration, use
`ROBINHOOD_MCP_CLIENT_REGISTRATION_URL` instead of `ROBINHOOD_MCP_CLIENT_ID`.
Then run the app locally and open `/api/auth/robinhood/start` to complete consent.
The app stores OAuth state, the registered client, and refreshable tokens in the
local SQLite settings table.

## Tests

```bash
npm test
```

60 tests across 9 suites (vitest). Run after `npm install`.
