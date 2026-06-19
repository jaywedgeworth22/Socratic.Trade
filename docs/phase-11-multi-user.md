# Phase 11 - Multi-user & API-key management (plan)

Goal: let multiple users use the app — logging in at the same or different times —
each getting analysis and trade proposals tailored to **their own preferences and
their own API keys**. Paper mode stays the default; no live-trading behavior change.

**For now (testing):** no login portal. A single default user (`local`) is active;
everything is scoped to that user so the multi-user plumbing is exercised without
auth. A real login/identity layer is the last milestone.

## What already exists (foundation)
- `user_api_keys` table + `getUserApiKey`/`listUserApiKeys`/`upsertUserApiKey`/
  `deleteUserApiKey`/`resolveApiKey(service, userId?)`/
  `resolveApiKeyWithSource(service, userId?)` in `src/lib/db.ts`. Service names are
  canonicalized, saved keys are encrypted, user keys win, and env vars remain the
  shared fallback.
- `connected_accounts` brokerage-account storage for the default `local` user.
  Connected account credentials are encrypted at rest, omitted from dashboard
  snapshots, decrypted only for backend active-account use, and preserved when
  editing account metadata with blank key fields. Alpaca now resolves credentials
  from the active connected account before falling back to legacy per-user/env keys.
- Robinhood MCP now has a hardened Streamable HTTP path: the adapter defaults to
  Robinhood's official Trading MCP endpoint, sends `Accept: application/json,
  text/event-stream` plus `MCP-Protocol-Version`, parses both JSON and SSE `data:`
  responses, unwraps Robinhood's `data` envelope, and exposes
  `/api/broker/mcp/health` for OAuth/token and `tools/list` diagnostics.
- Strategy profiles and prompts are now consistently scoped by `userId` for the
  default-user path; active-profile persistence writes to `user_settings`.

## Milestones

### M1 `[done]` API-keys Settings section (buildable now, single-user)
A Settings → **"API Keys"** tab listing every required + optional/helpful key with a
status badge (Set / Using env / Not set) and a masked input to save/clear it. Stored
per-user via `upsertUserApiKey` under the default user.
- **Required for full function:** `OPENAI_API_KEY` (LLM proposals).
- **Optional enrichment / signals:** `FINNHUB_API_KEY`, `FMP_API_KEY`,
  `ALPHAVANTAGE_API_KEY`, `MARKETSTACK_API_KEY`, `TRADIER_API_KEY`, `FRED_API_KEY`
  (macro), `SEC_EDGAR_USER_AGENT` (politeness).
- **No key needed (note this in the UI):** Yahoo Finance, Senate eFD, Capitol
  Trades, SEC EDGAR (UA only), FINRA short-volume.
- **Live trading (optional):** the `ROBINHOOD_MCP_*` credentials. The default
  Trading MCP URL is `https://agent.robinhood.com/mcp/trading`.
- Each row shows what it unlocks and links to where to get it. Never display stored
  secrets (mask), and never log them.

Current implementation: Settings → API Keys lists OpenAI, Finnhub, FMP, Alpha
Vantage, Marketstack, Tradier, FRED, SEC EDGAR User-Agent, and Massive with Set /
Using env / Not set badges, docs links, masked write-only inputs, Save, and Clear.
Backend `GET/POST/DELETE /api/keys` serves the same catalog and never returns
secret values. Settings → Accounts continues to own brokerage-account credentials.
Settings → Accounts also shows a Robinhood MCP status card backed by
`GET /api/broker/mcp/health`, with refresh and OAuth-connect actions. Mutable
account/key/order/policy route handlers touched by this flow are marked
`dynamic = "force-dynamic"` so production builds do not attempt static page-data
collection for request-bound operations.

### M2 `[partial]` Route providers through `resolveApiKey(service, userId)`
Replace direct `process.env.X` reads in `data-providers.ts`, `macro.ts`, the LLM
caller, and `web-sources/*` with `resolveApiKey(service, userId)` so a user's own key
takes precedence, with the env var as the shared fallback. Keep capability-gating:
missing key → that provider is skipped (neutral/stale signal), never faked.

Current partial implementation: Alpaca uses the active connected account first.
`resolveApiKey` now routes OpenAI proposal/tuning/red-team/post-mortem calls,
Finnhub/FMP/Alpha Vantage enrichment, FRED macro + macro history, Tradier/
Marketstack/Massive OHLC, Massive breadth/news/flat-file helpers, SEC EDGAR
User-Agent, and Pinecone/Voyage. Remaining work is mostly architectural: make
every future keyed connector accept `userId`, continue removing legacy direct
env reads when new sources land, and verify source attribution when a saved user
key overrides env.

### M3 `[todo]` Per-user preferences & policy
Today `TradingPolicy`, profiles, prompt, and tuning are global (one row). Scope them
by `userId`: each user has their own policy/profiles/horizon/risk/tuning/tax/scoring
weights. The default user keeps the current global config (migrate it in).

### M4 `[partial]` Per-user data isolation
`fill_events`, `portfolio_snapshots`, `trade_proposals`, scorecards, and the
`web-sources` *datasets* — decide what's shared vs per-user. Market data + scraped
signals (congress/insider/FINRA) are **shared** (same for everyone, cached once);
**policies, proposals, fills, P&L, learning scorecards are per-user**. Add a
`user_id` column (default `local`) to the per-user tables and scope all queries.
Some default-user paths are already scoped, including proposal approval, daily
execution stats, strategy-run audits, fill reconciliation, fill insertion, and
portfolio snapshots. Current implementation also scopes paper portfolio projections,
thesis/regime/sector/signal/factor scorecards, tax and wash-sale reads,
notification events, post-mortem reflection storage, dashboard proposal callbacks,
and prompt cache keys by `userId`. Remaining work: request-level user resolution
for API routes, a complete query audit, and deciding whether any future learning
materialization tables are shared or per-user.

### M5 `[partial]` Concurrent per-user execution
The scheduler runs one global strategy today. Make it iterate active users, running
each user's strategy under that user's policy/keys, with **per-user run-lock and
daily limits** (the lock + `dailyExecutionStats` become user-scoped). Bound total
concurrency. Current implementation has broader active-user discovery and per-user
strategy run locks, while daily execution stats are already user-scoped. Remaining:
bounded parallelism, explicit per-user scheduler controls/status, and request/auth
identity before non-local users are exposed.

### M6 `[todo]` Identity / auth (last)
A minimal login (or per-user API token) and a user switcher; until then the default
`local` user is implicit. Per-user Robinhood account linking lives here.

## Sequencing & risk
M1 → M2 are near-term and low-risk (additive; default user). M3–M5 are the real
architectural lift (userId scoping across the DB + scheduler) and should land
together behind the existing single-user default so nothing breaks during testing.
M6 (auth) is deliberately last.

## Acceptance
Single-user behavior is byte-for-byte unchanged with the default user; adding a key
in Settings makes that provider use it (verified via the source attribution string);
two users with different policies produce different proposals from the same shared
market data; secrets are never shown or logged; paper mode stays default.
