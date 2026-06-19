# Robinhood Agentic Trading Dashboard

Local-only Next.js dashboard for managing a Robinhood agentic account through MCP.

## For AI Tools And Contributors

Read these before changing code:

1. `AGENTS.md` for durable repo rules, verification commands, and cross-file traps.
   `CLAUDE.md` is a symlink to the same file so Claude Code reads identical rules.
2. `STATUS.md` for the current handoff snapshot.
3. `PLAN.md` for the roadmap and acceptance checks.
4. `docs/rollouts/` for chronological handoff notes so Codex, Claude Code,
   Antigravity/Gemini, Cursor, or a human can resume cleanly.
5. The relevant `docs/phase-*.md` and latest matching `docs/rollouts/*.md`.

Non-trivial changes must update `STATUS.md`, `PLAN.md`, the relevant phase doc,
and a dated rollout note before commit/push. Do not recreate a single
`docs/HANDOFF.md`; that was intentionally replaced by rollout notes.

## What It Does

- Shows accounts, portfolio, positions, orders, and an audit feed.
- Runs an equity strategy loop in either proposal-only or decision mode.
- Scans the allowed equity universe with delayed quote data, fundamentals,
  technicals, macro/market signals, and cached public web-source evidence before
  asking the LLM for proposals.
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

Open `http://127.0.0.1:3000`.

For Codex sessions, use the pinned launcher instead:

```bash
npm run dev:codex
```

Open `http://127.0.0.1:3001`. The Codex launcher frees only port `3001` and
retries there if Next initially falls back to another port.

If the UI appears as plain, unstyled HTML, the dev server is likely serving stale
`.next` assets after a build. Stop the old listener only on the port your agent
owns, then restart the matching dev command. If you intentionally want the old
force-clean behavior for the default Claude/local port, use `npm run dev:clean`;
the default `dev` script does not kill unrelated port-3000 processes.

## Environment

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini        # or gpt-4o for deeper reasoning
OPENAI_API_URL=...               # optional: override to use an OpenAI-compatible endpoint
ROBINHOOD_ADAPTER=mock           # "mock" (default) or "mcp" for real Robinhood MCP
DATABASE_URL=file:./data/app.db
ENCRYPTION_KEY=...               # optional 64-char hex key; used for stored API keys
MARKET_SCAN_LIMIT=30
MARKET_SCAN_CACHE_TTL_MS=300000
MARKET_SCAN_EVENT_RESERVE=8

# Optional: fundamentals + analyst enrichment (Finnhub).
# Provides P/E, EPS, dividend yield, analyst ratings, sector/industry, and news
# sentiment per symbol. Yahoo Finance (no key required) is always the final
# enrichment tier, so every scanned symbol has real data even with no keys set.
# The scan's `source` field lists every provider that actually supplied data for
# that run (e.g. "nasdaq-delayed-screener+finnhub+yahoo-finance+robinhood-quotes");
# each table cell's tooltip names the single provider that value came from.
FINNHUB_API_KEY=...

# Optional: Financial Modeling Prep (adds P/E + analyst consensus; Finnhub preferred).
FMP_API_KEY=...
FMP_MAX_SYMBOLS=15               # cap enriched candidates per scan (free-tier quota friendly)
NEWS_CACHE_TTL_MS=21600000       # enrichment cache TTL (default 6h)

# Optional: Alpha Vantage NEWS_SENTIMENT enrichment.
ALPHAVANTAGE_API_KEY=...

# Optional: macroeconomic context injected into LLM prompt (Federal Reserve FRED API).
# Adds rates, inflation, labor, credit, oil, dollar, VIX/VIX3M, and derived curves.
# Without a key the prompt uses hardcoded recent defaults (updated periodically in macro.ts).
FRED_API_KEY=...

# Optional: public web-source and technical-signal controls.
SEC_EDGAR_USER_AGENT=RobinhoodAgenticTrading/1.0 (contact: you@example.com)
WEB_SOURCE_CONGRESS=on
WEB_SOURCE_INSIDER=on
WEB_SOURCE_FINRA=on
WEB_SOURCE_SEC8K=on
WEB_SOURCE_TECHNICAL=on
TECHNICAL_SOURCE=tradingview       # "tradingview" webhook or free "computed" Yahoo/Stooq OHLC
WEB_SOURCE_TECHNICAL_MAX=40
TRADINGVIEW_WEBHOOK_SECRET=...
TRADINGVIEW_WEBHOOK_IPS=...

# Optional: RAG context for filings/research.
VOYAGE_API_KEY=...
PINECONE_API_KEY=...

# Optional: native Alpaca paper account credentials. The UI-connected account
# store takes precedence when an active Alpaca account is selected.
ALPACA_PAPER_API_KEY=...
ALPACA_PAPER_SECRET_KEY=...

# Optional/future provider keys routed through the per-user key system as it lands.
MARKETSTACK_API_KEY=...
TRADIER_API_KEY=...
MASSIVE_API_KEY=...
MASSIVE_S3_ENDPOINT=...
MASSIVE_BUCKET=...
MASSIVE_ACCESS_KEY_ID=...
MASSIVE_SECRET_ACCESS_KEY=...

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
npx tsc --noEmit
npm test
npm run build
```

As of 2026-06-18 the suite is roughly 195 tests across 27 files; treat the
command output as authoritative because the count changes frequently.

## Design Docs

See `docs/` for phase-by-phase design notes, including `docs/phase-7-strategy.md`
(in-progress: trade-thesis tagging, post-mortem reflection loop, short-selling
support — see that doc's own risk-guardrail section before enabling `short`/`cover`
proposals in Live mode).

`docs/rollouts/` contains chronological handoff notes. Use these notes to
understand recent implementation decisions, verification results, and known
follow-ups before starting new work.
