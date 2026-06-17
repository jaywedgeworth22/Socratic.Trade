# Phase 11 - Multi-user & API-key management (plan)

Goal: let multiple users use the app — logging in at the same or different times —
each getting analysis and trade proposals tailored to **their own preferences and
their own API keys**. Paper mode stays the default; no live-trading behavior change.

**For now (testing):** no login portal. A single default user (`local`) is active;
everything is scoped to that user so the multi-user plumbing is exercised without
auth. A real login/identity layer is the last milestone.

## What already exists (foundation)
- `user_api_keys` table + `getUserApiKey`/`listUserApiKeys`/`upsertUserApiKey`/
  `deleteUserApiKey`/`resolveApiKey(service, userId?)` in `src/lib/db.ts`
  (scaffolding, currently unused by providers). `resolveApiKey` already falls back
  to the matching `process.env` var when a user hasn't supplied a key.

## Milestones

### M1 `[todo]` API-keys Settings section (buildable now, single-user)
A Settings → **"API Keys"** tab listing every required + optional/helpful key with a
status badge (Set / Using env / Not set) and a masked input to save/clear it. Stored
per-user via `upsertUserApiKey` under the default user.
- **Required for full function:** `OPENAI_API_KEY` (LLM proposals).
- **Optional enrichment / signals:** `FINNHUB_API_KEY`, `FMP_API_KEY`,
  `ALPHAVANTAGE_API_KEY`, `MARKETSTACK_API_KEY`, `TRADIER_API_KEY`, `FRED_API_KEY`
  (macro), `SEC_EDGAR_USER_AGENT` (politeness).
- **No key needed (note this in the UI):** Yahoo Finance, Senate eFD, Capitol
  Trades, SEC EDGAR (UA only), FINRA short-volume.
- **Live trading (optional):** the `ROBINHOOD_MCP_*` credentials.
- Each row shows what it unlocks and links to where to get it. Never display stored
  secrets (mask), and never log them.

### M2 `[todo]` Route providers through `resolveApiKey(service, userId)`
Replace direct `process.env.X` reads in `data-providers.ts`, `macro.ts`, the LLM
caller, and `web-sources/*` with `resolveApiKey(service, userId)` so a user's own key
takes precedence, with the env var as the shared fallback. Keep capability-gating:
missing key → that provider is skipped (neutral/stale signal), never faked.

### M3 `[todo]` Per-user preferences & policy
Today `TradingPolicy`, profiles, prompt, and tuning are global (one row). Scope them
by `userId`: each user has their own policy/profiles/horizon/risk/tuning/tax/scoring
weights. The default user keeps the current global config (migrate it in).

### M4 `[todo]` Per-user data isolation
`fill_events`, `portfolio_snapshots`, `trade_proposals`, scorecards, and the
`web-sources` *datasets* — decide what's shared vs per-user. Market data + scraped
signals (congress/insider/FINRA) are **shared** (same for everyone, cached once);
**policies, proposals, fills, P&L, learning scorecards are per-user**. Add a
`user_id` column (default `local`) to the per-user tables and scope all queries.

### M5 `[todo]` Concurrent per-user execution
The scheduler runs one global strategy today. Make it iterate active users, running
each user's strategy under that user's policy/keys, with **per-user run-lock and
daily limits** (the lock + `dailyExecutionStats` become user-scoped). Bound total
concurrency.

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
