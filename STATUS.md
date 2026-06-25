# Status

Current snapshot for fast handoff across Codex, Claude, Cursor, Gemini, or a
human contributor. Update this when active focus, risks, or near-term next
steps materially change.

## 2026-06-25 — App B return-path receiver + numeric analyst price targets (BUILT, default-OFF)
Built the inbound half of the App A return-path plus the price-target provider that fills the
analyst push's previously-null target columns. Merged on top of the fundamentals/analyst push that
already landed on main (`marketQuoteToFundamentals`/`marketQuoteToAnalyst`) — did NOT duplicate it.
- **Receiver (`feat/securities-import-receiver`):** new `POST /api/admin/securities/import`
  (bearer `APP_B_INGEST_TOKEN`, constant-time, default-closed) + new local writable EOD cache
  (`imported_securities_ref`/`imported_price_eod`/`imported_spx_eod` in `db.ts`,
  `db-securities-import.ts`, `securities-import-auth.ts`), wired as an OPT-IN, density-guarded
  `fetchDailyOHLC` tier (`SECURITIES_IMPORT_HISTORY_TIER_ENABLED`, `SECURITIES_IMPORT_MIN_BARS=200`).
  No-echo guard: outbound `congress-share` pushes are tagged `origin: app-b` and the receiver skips
  that origin. Receiver ignores insider/shortVolume/fundamentals/analyst on inbound (gap-fills are
  prices/spx/refs only).
- **Numeric analyst price targets:** opt-in FMP `price-target-consensus` (`FMP_PRICE_TARGETS_ENABLED`)
  threads `targetMean/High/Low/Median` through the whole enrichment surface (`SymbolEnrichment`,
  `EnrichmentSourcedField`, `takeScalar`, `EMPTY_SOURCED`, `MarketQuote`, `MarketQuoteSummary`,
  `EnrichmentSources`, `market.ts` merge) and into `marketQuoteToAnalyst`, so the analyst[] push fills
  those columns instead of null. Default-off → no behavior change.
- Verify: tsc clean · full vitest green except the pre-existing cache-provenance date flake · build
  green (`/api/admin/securities/import` registered). Operator: set `APP_B_INGEST_TOKEN`, hand App A
  the token + import URL out-of-band; flip the consume/targets flags when ready. A discovery sweep's
  off-theme backlog (chat tools, learning-loop wiring, money-path items, spend-gated caps) is listed in
  the rollout note — deferred, needs its own branches / owner sign-off.
  See `docs/rollouts/2026-06-25-app-b-securities-import-fundamentals-price-targets.md`.

## 2026-06-24 — App B reply to App A: return-path + analytics ownership
Authored App B's coordination reply to App A (congress.trade) on the two open
questions: the A→B price/spx/ref **return-path** and **composite-analytics
ownership**. New doc `docs/congress-trade-app-b-reply.md`. Decisions:
- **Return-path:** yes, we want it — but the inbound receiver **does not exist
  yet** on our side (we have an outbound pusher + a cache-aside HTTP reader, but
  no `/securities/import` route and no local writable EOD price table). Specified
  the contract we'll expose (`POST /api/admin/securities/import`, bearer
  `APP_B_INGEST_TOKEN`, default-closed, mirrors the body we already POST to App A).
- **Analytics:** accepted App A's ownership split (they own congressional-trade
  analytics, we own market/price analytics) and chose **pull/pull** — we keep
  consuming their `/api/analytics/*` (already wired in `congress-analytics.ts`),
  they keep pulling our `/api/market/*`. No aggregate pushing either direction.
- **Fundamentals/analyst push (their PR #46):** we'll wire `fundamentals[]` +
  `analyst[]` onto the nightly batch; we can fill the fundamentals set + analyst
  grade-counts/rating, but **not** numeric price targets (not sourced → null).
No production code changed this pass; two follow-up PRs scoped (receiver+EOD cache
tier; fundamentals/analyst push). Branch `claude/app-b-analytics-return-path-a50as4`.
See `docs/rollouts/2026-06-24-app-b-analytics-return-path-reply.md`.

## 2026-06-24 — Intrinio / Tiingo / TwelveData + GCP Secret Manager wired
Three new data enrichment providers integrated into the cascade (Intrinio, Tiingo, TwelveData).
GCP Secret Manager runner script added. API keys loaded into .env.local.
Branch: claude/magical-faraday-uce1uy

## Current State

- App: local-only Next.js agentic trading dashboard with honest
  **Test / Paper (Alpaca) / Brokerage** execution modes driven by the active
  connected account, policy gating, equity-only execution, and a phase-based
  design roadmap.
- Roadmap: `PLAN.md` tracks the cross-phase implementation order; `docs/`
  contains the per-phase design details.
- Latest documentation audit: 2026-06-18 reviewed all repo-authored Markdown
  outside dependency/generated directories, including ignored iCloud conflict
  copies. Canonical current docs were refreshed; ignored `" 2.md"` files are
  stale conflict snapshots and should not be used as source of truth.
- Latest completed design area in docs: `docs/phase-10-signals-learning-ui-v2.md`
  now reflects current shipped signals/learning/UI work and remaining gaps.
- GitHub: `main` and `phase-10` were pushed at `9bcf133` before the current
  follow-on Phase 10 work. Check `git status` before committing because Massive
  breadth/macro-sparkline work and RAG hardening may be in the local worktree.

## Active Focus

- 2026-06-25 (`claude/sell-to-fund-buy`, **PR 3 of 3**): **Sell-to-fund-buy 3-way setting.** Opt-in
  `policy.sellToFundBuy` (`off`|`suggest`|`propose`|`automated`, **default off**): when a run's intended
  buys exceed buying power, optionally raise cash by trimming the largest unrealized losers (never the
  buy targets, longs only). Pure tested planner `src/lib/sell-to-fund.ts`; run-loop integration emits
  funding sells per mode (suggest=record only, propose=await approval even under decide, automated=ride
  authority). No same-run sell→fill→buy sequencing (buys retry next cadence). Default-off = zero
  production change. Verified: tsc clean; 1089/1090 (only cache-provenance flake); build green. See
  `docs/rollouts/2026-06-25-sell-to-fund-buy.md`. **Completes the 3-PR per-account/strategy roadmap.**
- 2026-06-25 (`claude/strategy-copy-to-account`, **PR 2 of 3**): **Strategy library copy-to-account.**
  New `applyProfileToAccount(profileId, connectedAccountId, userId)` copies a saved library strategy
  into a CHOSEN account's live `account_strategy_state` (not just the active one), stamping
  `derived_from_profile_id` and **preserving the target's run-state** (copying never arms/disarms
  autonomy). New `POST /api/profiles/[id]/copy`, `GET /api/connected-accounts` (safe list), and a
  "Copy this strategy to another account" control in the Strategy tab. Verified: tsc clean;
  1084/1085 (only the cache-provenance env flake); build green. See
  `docs/rollouts/2026-06-25-strategy-copy-to-account.md`. PR 1 (#128) deployed to production.
- 2026-06-24 (`claude/per-account-isolation`, **COMPLETE / PR #128 ready**): **Per-account state
  isolation — PR 1 of 3, all slices landed.** Each connected account gets its own isolated state
  instead of all of a user's accounts sharing one. Owner decision: full isolation, except shareable
  (fact-tier) learning stays user-wide; `strategy_profiles` is a copyable **library** + each account
  has its own **live** state. DONE (verified green — tsc clean, 1075/1076 = only the unrelated
  `cache-provenance` macro-cache flake, build green): (1) schema `account_strategy_state` + nullable
  `connected_account_id` tags; (2) core policy + system-state isolation in `getPolicy/setPolicy`;
  (3) run-state/run-lock per account; (4) audit/notification account tagging; (5) performance-learning
  per account (counterfactuals + watermark PK-rebuilt to `(user_id, connected_account_id)`);
  (6) scheduler multi-account iteration with `runStrategyOnce(userId,{connectedAccountId})` override
  + a **safety guard** that seeds non-active accounts `halted` so autonomy never auto-arms a dormant
  account; (7) deletion purge of all per-account state. Tests in
  `test/per-account-policy-isolation.test.ts`. See `docs/design/per-account-isolation.md` +
  `docs/rollouts/2026-06-24-per-account-isolation.md`. NOTE: merge to `main` lands it; **production
  deploy is a separate manual step on the owner's host** (pull `main` on `~/apps/trading-live`,
  rebuild, `pm2 restart trading`) — not reachable from the cloud agent env.

- 2026-06-24 (`fix/land-workflow-scope-guard`): **Agents can push `.github/workflows/` changes directly.** Root cause wasn't a permission gap — the gh token already has the `workflow` scope and `git push` uses `gh auth git-credential` — it was a STALE `scripts/land.sh` guard that always `die`d on a workflow diff. Made step 5 **scope-aware**: allow the push when `gh auth status` shows the `workflow` scope (the common case), only block (with `gh auth refresh -h github.com -s workflow` guidance) when it's genuinely missing. Corrected `AGENTS.md` step-7 + the stale `ci-pending/README.md` note. This PR proves it end-to-end — its diff includes a `.github/workflows/ci.yml` header comment (documenting `verify` as the required ruleset check), so the push exercises the workflow-scope path. Also closed PR #84 (bot-identity — owner doesn't want enforced review). See `docs/rollouts/2026-06-24-land-workflow-scope-guard.md`.
- 2026-06-24 (`codex/alpaca-ticker-prod-update`): **Macro ticker click polish + Alpaca account inference.**
  Extracted the shared Market Scan-style ticker button so Macro movers/news tickers get the same
  hover/click treatment and open symbol drilldown, with ticker-logo display passed through. Simplified
  Add Alpaca Account by removing the top Paper/Brokerage endpoint explanation, inferred Paper from
  either account number `PA...` or API key `PK...` in the client and server route, changed the live
  Alpaca default endpoint to `https://api.alpaca.markets` (no `/v2`), and added best-effort Alpaca
  IRA account-type parsing when broker payloads expose `account_type`/`account_sub_type`. Verification:
  `npx tsc --noEmit`; focused `npx vitest run test/connected-accounts-route.test.ts
  test/alpaca-account-type.test.ts`; full `npm test` (123 files / 1066 tests); `npm run build`;
  `git diff --check`. Production update requested after landing; see
  `docs/rollouts/2026-06-24-ticker-alpaca-production-update.md`.
- 2026-06-24 (`chore/paid-data-tier-limits`): **Captured the paid Polygon/Massive + FMP "Starter" tiers.** Owner upgraded both (already wired via `MASSIVE_API_KEY`/`FMP_API_KEY`). Raised `DEFAULT_REST_MAX_CALLS_PER_MINUTE` 5→100 in `market-signals/massive.ts` (Starter = unlimited; 5/min was the free-tier cap that throttled breadth/news and forced Massive history to fall through to rate-limited Yahoo) and fixed stale `.env.example` (`MASSIVE_REST_MAX_CALLS_PER_MINUTE` 5→100, `FMP_MAX_SYMBOLS` 15→30; FMP code default was already 30). Paid FMP auto-restores the sector/industry/news fields the free tier dropped. No schema/new providers. **Operator action:** set the paid keys + `FMP_MAX_SYMBOLS=30` in the live `.env.local`, `pm2 restart trading --update-env`. tsc clean · history tests 13/13 · trio via land.sh. See `docs/rollouts/2026-06-24-paid-data-tier-limits.md`. (From the paid-tier value survey: these two were the high-value in-budget picks; everything else stays free.)
- 2026-06-24 (`claude/fix-evaluator-cadence-dead-field`): **Removed dead `evaluatorCadenceHours`
  policy field.** It was declared on `TradingPolicy` (`types.ts`) and accepted in the tuner
  patch-keys union, so it persisted when set but had **zero readers** — a misleading "cadence"
  control that did nothing (flagged as pre-existing in the safety-fixes A–E note). Removed from
  both declaration sites; no default/validation/UI referenced it, so no migration needed (extra
  keys on already-persisted policy JSON are ignored by `mergePolicy`). tsc clean; 1061/1062 tests
  (only the pre-existing `cache-provenance` date flake); build green. See
  `docs/rollouts/2026-06-24-fix-evaluator-cadence-dead-field.md`. NOTE: an audit for similar
  silent free-tier caps + dead controls was run this session — top items: Voyage 21s batch delay
  (free-tier 3 RPM → slow bulk ingest), filing-body ingest 1/tick on free tier, scan enrichment
  capped to top 30, Alpaca price-event stream silently drops symbols >30. Documented for the owner;
  not yet fixed (see chat).

- 2026-06-24 (`claude/safety-fixes-a-e`): **Codex-review safety fixes A–E** (re-verified
  against current `main`, which had advanced past the review base). A (HIGH): OOS gate now
  validates the ACTUAL proposed scoring weights vs current weights, not the data-derived IC
  weights (`backtest.ts`/`strategy-tuning.ts`); fallback footgun removed (skips gate if
  candidate/baseline ICs absent rather than reverting to the old comparison). B (MED):
  already fixed on main by #109 (daily-order-count cap guards on `isOpening`). C (MED):
  synthetic trailing-stop skips symbols with a live broker-held bracket stop
  (`synthetic-stops.ts`), keyed off actual resting orders so nothing is left unprotected.
  D (MED): `upsertConnectedAccount` tenant guard blocks cross-user row overwrite via a
  guessable id. E (LOW): stale execution-cost comment fixed; Grok `max_completion_tokens`
  verified correct (xAI deprecated `max_tokens`). Reviewed by per-fix adversarial agents
  (Haiku on D/E, Sonnet on A/C). tsc/build clean; 1008/1009 tests (only the pre-existing
  `cache-provenance` date flake). See `docs/rollouts/2026-06-24-safety-fixes-a-e.md`.
  NEXT staged PRs: per-account state isolation → shared saved-strategy library +
  copy-to-account → sell-to-fund-buy (3-way setting: Automated/Propose/Suggest,
  default = account's current mode).

- 2026-06-24 (`feat/proposal-perf-and-rag-power`): **Performance-since-proposal surfacing + Voyage/Pinecone at full power** (after a 6-agent review). **Part A — show stock performance from the proposal date, esp. rejected:** every proposal is guaranteed a `referencePrice` anchor (`ensureReferencePrice`); the dashboard computes a side-adjusted `performanceSinceProposalPct` per recent/pending proposal from prices already in hand (new pure `returnSinceProposalPct` in `performance.ts`) — no new calls; UI shows a colored "since X%"/"missed X%" chip on pending + decision-ledger cards and the counterfactual note now covers all statuses; and a user-REJECTED proposal is fed into the existing skipped-candidate counterfactual pipeline (`recordRejectedProposalCounterfactual` → matures via `fetchDailyOHLC`) so its post-rejection return reaches missed-opportunity analytics (additive, no schema change). **Part B — Voyage/Pinecone fullest power:** Voyage **reranking** (rerank-2.5) over an over-fetched candidate set in `retrieveContextDetailed` (ON by default `VECTOR_ENABLE_RERANK`, fails safe to cosine order) — the biggest retrieval-quality lever; **8-K look-ahead fix** (vectors now carry `acceptance_datetime`+`doc_type`, activating the `isWithinAsOf` point-in-time guard); optional query-time metadata filters (`docType`/`section`/`source`) + `minScore` floor; memoized clients. All advisory/observability-only (no fills/policy writes; RAG stays prompt DATA). Gated follow-ups (paid Voyage batch profile; voyage-3-large 1536-dim reindex) documented in `docs/prod-config-voyage.md`. tsc clean · 1041 tests (+18) · build green. Isolated worktree off `origin/main`; landing via PR. See `docs/rollouts/2026-06-24-proposal-perf-and-rag-power.md`.
- 2026-06-24 (`claude/magical-faraday-uce1uy`): **Intrinio, Tiingo, TwelveData enrichment providers + GCP Secret Manager runner.**
  Wired three new providers into the cascading enrichment cascade: `IntrinioEnrichmentProvider` (7 parallel calls per symbol: realtime price, company profile, PE/EPS/dividend_yield/52-week range), `TiingoEnrichmentProvider` (IEX quotes + company name + news/sentiment), `TwelveDataEnrichmentProvider` (batch `/quote` call for all symbols with price/volume/sector/industry/PE/EPS/beta/52-week). All three registered in `API_KEY_ENV_MAP`/`API_KEY_SERVICE_ALIASES`/`API_KEY_TIER` as `shared-operator-infra`. Added `scripts/gcp-secrets-run.mjs` mirroring the Infisical runner; `package.json` gains `dev:gcp`/`build:gcp`/`start:gcp` scripts and `@google-cloud/secret-manager ^5.6.0`. Real API keys stored in `.env.local` (git-ignored). Verification: `npx tsc --noEmit` clean, `npm test` 935/936 pass (1 pre-existing `cache-provenance` failure), `npm run build` green. See `docs/rollouts/2026-06-24-intrinio-tiingo-twelvedata-gcp-secrets.md`.
- 2026-06-22 (`feat/correlation-cluster-gate`): **Optional correlation cluster gate (default off).** `policy.maxAvgCorrelation` (0–1) — the precise version of `maxPortfolioBeta`: an OPENING buy/short is SKIPPED before execution when the candidate's avg daily-return correlation (Pearson, ~90 common trading days, via `fetchDailyOHLC` bars) to current holdings exceeds the cap. New `src/lib/correlation.ts` (pure `closesByDate`/`alignedReturns`/`pearson` + async `avgReturnCorrelation`, injectable fetcher) + `applyCorrelationClusterGate` wired into `runStrategyOnce` (async; the sync policy gate can't fetch bars). Exits/reductions always pass; skips when bar data is insufficient (never false-rejects). Policy-route validated + "Max avg correlation" Settings field by the beta cap. Surfaced from the closed PR #89 review; off by default → no behavior change unless enabled. tsc clean, **1006 tests** (+8), build green. Built in `~/apps/trading-corr` off `origin/main`; landing via PR. See `docs/rollouts/2026-06-22-correlation-cluster-gate.md`.
- 2026-06-22 (`feat/negative-ev-skip-gate`): **Optional negative-expectancy skip gate (default OFF).** `policy.tuning.skipNegativeExpectancy` — when on, an opening proposal is SKIPPED before sizing (no order) if its thesis is PROVEN (≥ min lots) AND its shrunk realized post-cost edge ≤ `skipNegativeExpectancyEdgePct` (default 0). New `shouldSkipNegativeExpectancy` + extracted shared `selectThesisStat` (same bucket the sizer reads, no drift); wired as a pre-sizing filter in `runStrategyOnce` (logged + audited). Unproven theses are NEVER skipped (their exploratory floor is intentional). Exposed as a Settings toggle + threshold field, validated in the policy route. Opt-in, more-conservative stance surfaced by the closed PR #89 review — default behavior unchanged. tsc clean, **1007 tests** (+9), build green. Built in `~/apps/trading-ev-gate` off `origin/main`; landing via PR. See `docs/rollouts/2026-06-22-negative-ev-skip-gate.md`.
- 2026-06-23 (`feat/rh-stops-price-triggers-spy-bench`): **Three deferred Antigravity follow-ups, built after reviewing the Codex bundle (#113) + safety (#109) + auth (#110).** (1) **True Robinhood broker-held protective stops** — new `broker-protective-stops.ts` places a resting GTC stop-market SELL at `stopLossPct` below entry for each open live-RH long and cancels it on close / synthetic-exit (no orphaned stops); new `broker_protective_stops` table; runs from the synthetic monitor each tick (self-heals on restart). **DEFAULT OFF** behind `policy.robinhoodBrokerStops` (verify RH MCP stop semantics live first; synthetic monitor stays the fallback). (2) **Alpaca real-time price event-trigger producer** — new `streams/alpaca-price-events-stream.ts` subscribes to minute bars for active users' watched symbols, runs a pure deterministic filter (prior-day-high break / intraday move / volume spike), and fires `submitMaterialEvent` per watching user. **DEFAULT OFF** (`STREAMS_ALPACA_PRICE_EVENTS_ENABLED`; needs `TRIGGER_ENGINE=1`). The missing live-price source for the event engine #96 built. (3) **SPY-benchmark scoreboard** — new `benchmark.ts` normalizes the account equity curve vs SPY buy-and-hold to 100, surfaced as "+X% vs SPY" under the equity chart (`performance.benchmark`); the honest beat-the-market readout (measurement, not alpha). All additive/opt-in → no behavior change by default. tsc clean · 957 tests (+20) · build green. Isolated worktree off `origin/main`; landing via PR. See `docs/rollouts/2026-06-23-rh-stops-price-triggers-spy-bench.md`.
- 2026-06-22 (`agent/claude-congress-share`, round 3): **Consume App A's "Trends" analytics + sync origin/main.**
  Merged a large origin/main (scan refactor) keeping the congress hooks; then built the App A **analytics
  overlay** (`CONGRESS_ANALYTICS_ENABLED`, default off): `congress-analytics.ts` pulls App A's
  ticker-leaderboard (dollar net flow, member counts) + cluster-buys + member-leaderboard (track-record)
  daily, persists a per-symbol `CongressAnalytics` overlay on `SymbolWebSignal`, and `outlierInterestScore`
  folds it into scan candidate selection (`congressAnalyticsScore`: net-flow + cluster + member quality;
  net-selling=0; additive/back-compat). Comprehensive App A coordination note: `docs/congress-trade-app-a-note.md`.
  tsc clean · **1005 tests / 112 files** · build green. Gate unchanged: App A's feed is still seed/historical,
  so keep the consume flags off until it carries current disclosures. See `docs/rollouts/2026-06-22-congress-trade-consume.md`.
- 2026-06-24 (`claude/strategy-flow-live`): **Strategy Flow popup is now live/data-driven.**
  Rewrote `app/ui/strategy-flow.tsx` from a hardcoded decorative React Flow
  diagram into a snapshot-driven pipeline status view — node colors/details
  reflect which data sources are enabled & have data, last-run candidate/proposal
  counts, gate state, and execution mode (Test/Paper/Brokerage · Propose/Autonomous).
  Wired `snapshot` through from `dashboard-client.tsx`; re-seeds on each poll.
  tsc/build clean; 935/936 tests (only the pre-existing date-sensitive
  `cache-provenance` flake fails). See `docs/rollouts/2026-06-24-strategy-flow-live.md`.
  Separately, deep-reviewed Codex's recent auth/money-path/learning-loop work —
  notable: a HIGH OOS-gate logic bug (`strategy-tuning.ts` validates data-derived
  IC weights, not the proposal's weights) and a MEDIUM "daily order-count cap can
  block a protective exit" (`policy.ts:178` not guarded on `isOpening`). Reported
  to owner; not yet fixed.

- 2026-06-22 (`agent/claude-congress-share`, round 2): **Bidirectional congress.trade — receiving side (default OFF).**
  Added App B's consume side on top of the push side: (1) **cache-aside reads** of App A's
  `/api/market/*` as the first tier of `fetchDailyOHLC` (saves keyed-history quota; close-only on hits)
  — `CONGRESS_TRADE_READS_ENABLED`; (2) **App A as congressional source** — `refreshCongress` pulls
  App A's **public** `/api/transactions` feed (rolling ~90d cursor pagination, no token; tolerant
  `coerceCongressTrade` mapped to App A's confirmed object shape) instead of scraping —
  `CONGRESS_TRADE_AS_CONGRESS_SOURCE`; (3) **push
  receiver** — webhook `POST /api/webhooks/congress` (constant-time bearer `CONGRESS_WEBHOOK_SECRET`) +
  outbound **SSE** consumer (`CONGRESS_STREAM_ENABLED`, `Last-Event-ID` resume), both feeding
  `applyCongressEvent` → existing `getSymbolWebSignals` overlay. Built via a 5-agent mapping pass + a
  10-agent adversarial review; **all 6 verified findings fixed** (unparseable-date ingestion, added-count
  under retention pruning, chamber `startsWith("sen")`, empty-owner default, SSE drop logging, seq/gap
  documented). Contract files for App A: `docs/push-to-app-b.md`, `docs/congress-trade-consume.md`. tsc
  clean · `npm test` 920 pass (98 files, +36 new) · build green. Round-2 contract finalized: the
  `/api/transactions` feed is **public** (no token); cache-aside `closes` carry `volume`; and the nightly
  **push** now also forwards `insider[]` + `shortVolume[]` (App A added the import slots) +
  `volume`-on-closes (`buildInsiderImport`/`buildShortVolumeImport` from App B's cached web-sources).
  **Live-verified (2026-06-22 PM):** App A endpoints up (`/api/health` `db:true`); cache-aside reads
  cold→fall through cleanly; `/api/transactions` shape matches the coercer. Fixed: the feed is
  oldest-first by `cursor_seq` (insertion order), so `fetchAppACongressTrades` now bounds the window via
  App A's `?from=` param (verified live). **Real gate:** App A's transactions feed is still seed/historical
  (mostly 2012–2020) — keep `CONGRESS_TRADE_AS_CONGRESS_SOURCE` OFF until it carries current disclosures;
  cache-aside reads + nightly push are safe to enable now. **Top next:** consume App A analytics
  (member track-record weighting, cluster-buys, per-trade performance) to upgrade the congressional signal.
  See `docs/rollouts/2026-06-22-congress-trade-consume.md`.
- 2026-06-22 (`agent/claude-congress-share`): **Outbound data-share to congress.trade (App A) — default OFF.**
  New `src/lib/congress-share.ts` forwards the company `refs` + daily `closes` + `^GSPC` series this app
  already fetches to App A's idempotent `POST /api/admin/securities/import`, so App A can avoid spending the
  *shared* daily FMP quota. Two triggers: (1) **after each scan** — `scanMarket()` fire-and-forgets
  `shareScanRefs` (candidate refs, per-symbol 6h throttle, rollback-on-failure); (2) **nightly batch** — the
  scheduler tick runs `runCongressDailyShareIfDue` once/UTC-day over the union of all users' watchlist +
  policy-universe symbols, POSTing `prices`+`spx` in capped chunks (≤2000 tickers / ≤20000 closes/call).
  Manual ops trigger: `POST /api/admin/congress-share` (admin-gated, token-only). **Correction to the brief:**
  App B never calls FMP `/v3/profile` or `/v3/historical-price-full` (its only FMP use is fundamentals
  enrichment), so refs/prices/spx come from the screener enrichment + the `fetchDailyOHLC` cascade, not FMP —
  but sharing them still conserves App A's quota. Gated on `CONGRESS_TRADE_TOKEN` + `CONGRESS_SHARE_ENABLED`
  (both off by default); token is server-only; every POST is timeout-bounded + self-guarded. tsc clean ·
  `npm test` 884 pass (95 files, +25 new) · build green. See `docs/congress-trade-share.md` and
  `docs/rollouts/2026-06-22-congress-trade-share.md`. **Next:** owner sets the token + flag in the target
  worktree's `.env.local`, then optionally test via the admin route before enabling the auto hooks.
- 2026-06-24 (`codex/market-data-mcp-evaluation`): **Market-data MCP/provider evaluation.**
  Documented whether MCP should change the app's provider strategy for FMP,
  Alpha Vantage, Twelve Data, Tiingo, Intrinio, EODHD, FinancialData.net,
  Nasdaq Data Link, Tastytrade, Pyth, Databento, Unusual Whales, Trading
  Volatility, and a generic Yahoo-backed MCP server. Recommendation: keep
  direct REST/WebSocket adapters for scheduled scans, scoring, history, cache
  writes, and execution-adjacent data; use MCP for provider research,
  field-coverage exploration, trial benchmarking, and optional Strategy
  Studio-style deep dives only after normalizing outputs through the same
  source-attributed cache path. Intrinio should be benchmarked during the trial
  before paying $150/month; Tiingo is the best low-cost direct-adapter next
  step if the key is active; FinancialData.net/EODHD/Twelve Data are cheaper
  broad alternatives; Trading Volatility/Unusual Whales are differentiated
  options-flow overlays, not core price/fundamental replacements. No API keys
  were recorded. See `docs/data-provider-mcp-evaluation.md` and
  `docs/rollouts/2026-06-24-market-data-mcp-evaluation.md`.
- 2026-06-23 (`codex/ui-account-deletion-visual-pass` / Codex preview): **Current Codex bundle prepared for integration.**
  Bundled the current Codex preview changes for landing: custom Additional
  Watchlist ticker validation and error surfacing; expanded index universes and
  dynamic broad-scan narrowing; user-configurable Market Scan cap/outlier
  reserve; app-local account deletion lifecycle and account-row visual polish;
  stopped-system proposal action gating; and related docs/tests. Local
  verification passed before commit: `npx tsc --noEmit`, `npm test` (107 files /
  936 tests), `npm run build`, and `git diff --check`. Integration path is
  `scripts/land.sh` into `main`; beta follows the main integration worktree, and
  production follows the existing `main` deploy workflow. See
  `docs/rollouts/2026-06-23-codex-bundle-integration.md`.
- 2026-06-23 (`codex/ui-account-deletion-visual-pass` / Codex preview): **Visual QA + multi-step app account deletion.**
  Added a signed-in-user account deletion lifecycle with `GET/POST/DELETE
  /api/account/deletion`: preview counts, prepare-by-halting the user's system
  and clearing the run lock, typed-email/phrase confirmations, extra local
  operator phrase, in-flight placement/reconciliation blockers, transactional
  purge of private app data, per-user Robinhood MCP OAuth cleanup, and a minimal
  hashed deletion audit. Settings -> Data now has a danger-zone procedure that
  explains Google/Apple/broker limitations and requires multiple acknowledgements
  before deletion. Accounts rows now stack better on mobile, make inactive
  `Use` primary, and visually anchor the active account. Visual QA ran through
  desktop/tablet/mobile Playwright screenshots with the trusted Cloudflare
  Access email header: no horizontal overflow at 1440, 1024, or 390 px; the
  deletion modal opened on desktop/mobile. Verification: `npx tsc --noEmit`,
  focused `npx vitest run test/account-deletion.test.ts`, full `npm test` (107
  files / 936 tests), `npm run build`, `git diff --check`, local `/api/health`,
  and local deletion-preview API smoke all passed. Restarted `trading-codex`
  after build. See
  `docs/rollouts/2026-06-23-ui-account-deletion-visual-pass.md`.
- 2026-06-23 (`codex/ui-account-deletion-visual-pass` / Codex preview): **User-controlled Market Scan cap + stronger outlier reserve.**
  The Market Scan cap is no longer env-only. Per-user policy now carries
  `marketScanCandidateLimit` (default 30, bounded 10-100) and
  `marketScanOutlierReserve` (default 8, bounded 0-25 and never above the cap).
  `/api/scan`, scheduled strategy runs, and approval re-scans pass those values
  into `scanMarket`; the scan response reports the active cap, reserve, and
  outlier count. Settings -> Data exposes both controls, and the Market Scan tab
  now has a gauge shortcut that opens directly to those settings. The previous
  hidden prompt-side `score >= 40` filter was removed so scan outliers can
  actually reach the LLM when they are included in `topCandidates`. Below-cutoff
  outliers are now ordered by signal strength across congressional buying,
  insider buying, short pressure, and bullish technical signals before filling
  the reserve. Expert consensus documented in the UI/docs: 10-12 is the lowest
  reasonable cost-sensitive range, 25-40 is balanced, 60-80 is broad research,
  and 100 is the practical upper bound before attention dilution usually hurts
  proposal quality. Verification passed: `npx tsc --noEmit`, full `npm test`
  (106 files / 934 tests), and `npm run build`. See
  `docs/rollouts/2026-06-23-market-scan-cap-settings.md`.
- 2026-06-23 (`codex/ui-account-deletion-visual-pass` / Codex preview): **Expanded base index universes + broad-scan narrowing.**
  Added S&P 100, Nasdaq Composite, Russell 2000, NYSE Composite, and FT
  Wilshire 5000 universe options while keeping S&P 100 mutually exclusive with
  S&P 500 and Nasdaq 100 mutually exclusive with Nasdaq Composite in both the UI
  and policy API. Broad/dynamic universes now flow into Market Scan: Nasdaq/NYSE
  exchange universes use the existing Nasdaq screener filters, S&P 100 and
  Russell 2000 use BlackRock iShares holdings downloads (OEF/IWM), and FT
  Wilshire 5000 uses the app's free all-screener U.S.-listed proxy. The scan
  still ranks the broad universe down to the configured candidate cap before
  expensive enrichment and LLM prompting, so large selections broaden
  discovery without sending thousands of rows to the model. Dynamic-universe
  trade approval only passes when the symbol was present in the latest ranked
  scan, while manual chat drafts explain that broad indexes are scan-ranked and
  require either a scanned candidate or an explicit Additional Watchlist symbol.
  Verification: focused Vitest passed 55 tests; `npx tsc --noEmit`, full
  `npm test` (105 files / 927 tests), and `npm run build` passed; live-source
  smoke returned 101 S&P 100/OEF holdings, 1901 Russell 2000/IWM holdings, and
  2714 NYSE screener quotes; restarted `trading-codex`; local `/api/health`
  returned OK and public `codex.jays.services` returned the expected Cloudflare
  Access 302. See `docs/rollouts/2026-06-23-expanded-index-universes.md`.
- 2026-06-23 (`codex/ui-account-deletion-visual-pass` / Codex preview): **Custom Additional Watchlist tickers + visible error surfaces.**
  Additional Watchlist now accepts quote-resolvable custom U.S. equity/ETF
  tickers such as `SPCX` instead of limiting entries to the embedded S&P 500 /
  Nasdaq 100 / Dow 30 snapshots. Newly added custom symbols are quote-checked
  through the shared Yahoo Finance chart fetcher; if no quote is available, the
  policy save fails with a plain-English ticker-specific explanation. Market
  Scan now carries quote-only custom symbols forward when Nasdaq's screener
  omits them, and scan warning banners show the concrete warning text instead
  of a generic data-source message. App-level route/global error screens now
  show the real error message when available, and uncaught browser-side runtime
  errors surface as bottom-right toasts. Applied into `/Users/jay/apps/trading-codex`
  on top of the in-progress account-deletion work and restarted `trading-codex`
  for `codex.jays.services` / port `4101`. Verification: focused Vitest
  (`test/policy-custom-symbol.test.ts`, `test/market-custom-symbol.test.ts`,
  `test/alternative-data.test.ts`, `test/watchlist-alerts.test.ts`) passed 16
  tests; `npx tsc --noEmit`, full `npm test` (102 files / 915 tests), and
  `npm run build` passed; local `/api/health` returned OK. See
  `docs/rollouts/2026-06-23-custom-watchlist-errors.md`.
- 2026-06-23 (`codex/multi-user-auth-prod`): **Multi-user auth + account UI production pass.**
  Integrated the Auth.js/Cloudflare Access identity work onto current `origin/main`
  and fixed the account UI issues found during the expert/site pass. Middleware now
  fails closed whenever Cloudflare Access trust or `AUTH_SECRET` is configured,
  Auth.js cookies are decoded through `next-auth/jwt` instead of the broken
  `jose/jwt/verify` subpath, `/login` and `/logout` are public auth surfaces, and
  the server-rendered dashboard snapshot is request-scoped from the trusted
  middleware email so it no longer renders the primary/local dataset before
  hydration. The dashboard now shows signed-in email and Sign out, the top account
  selector uses the derived execution account ID with error-handled activation,
  Accounts has an explicit Use action, and the safety banner uses bold account
  labels plus italic risk details for Test / Alpaca Paper / Brokerage modes. The
  Alpaca account form now states the Paper and Brokerage default endpoints and only
  asks for a custom endpoint when enabled. Also fixed Alpaca MCP fractional position
  parsing (`quantity` as well as `qty`) so `0.5` AAPL shares do not collapse to
  `0 sh`. Verification: `npx tsc --noEmit`; focused Vitest
  (`test/alpaca-mcp.test.ts`, `test/middleware-auth.test.ts`,
  `test/request-user.test.ts`, `test/dashboard-feed.test.ts`) passed 31 tests;
  full `npm test` passed 99 files / 908 tests; `npm run build` passed with no
  edge-runtime warnings; `git diff --check` clean.
  See `docs/rollouts/2026-06-23-multi-user-auth-account-ui.md`.
- 2026-06-23 (`agent/codex-robinhood-account-integration`): **Expert safety/UI execution-mode pass.**
  Implemented the highest-risk Antigravity/expert-review plan slices in the
  Codex lane: Alpaca bracket dollar orders now fail closed without a real price
  anchor or at <1 whole share; close-only/liquidating scheduler ticks keep
  protective stop/reconciliation maintenance alive without running the LLM loop;
  execution mode is persisted separately from legacy `paper`/`live` source
  buckets for proposals, snapshots, and fills; broker-paper reads now use the
  paper bucket with `executionMode: "broker/paper"` instead of being mislabeled
  live/Test; stale proposal approvals now fail on account/mode mismatch; live
  approval POSTs require typed confirmation payloads; consent failures stay
  blocked; the mode banner can only be compacted, not hidden; a readiness strip
  is visible in the cockpit; `/api/ready` reports authenticated readiness; and
  Litestream npm/env drift plus vector raw-user credential lookup were repaired.
  Verification: `npx tsc --noEmit`, focused Vitest safety subset, full
  `npm test` (98 files / 894 tests), `npm run build`, and
  `PLAYWRIGHT_PORT=4217 npm run test:e2e -- --project=chromium` all passed.
  See `docs/rollouts/2026-06-23-expert-safety-ui-execution-mode.md`.
- 2026-06-23 (`HEAD` detached from `main`): **UI expert pass for strategy models, run-state clarity, Macro/Market Scan tooltips, and preview freshness.**
  Green/Red Team LLM controls now live in Strategy Studio, while Settings ->
  Connections shows the selected models as read-only context beside provider
  API keys. Manual **Run once** now sends a manual proposal-check request that
  can run while the system is stopped and forces proposal-only output; scheduled
  and autonomous runs still require Start. Header cleanup removed the top
  Refresh/Flow/Strategy shortcuts, preserved workspace/feed tabs across browser
  refresh, clarified `Mode:` as Propose Mode vs Autonomous Mode, routed the
  Settings Start/Stop button through the same confirmation modal, and translated
  raw provider/API errors into plain English. Macro movers are now `Top Gainers`
  / `Top Losers` with black clickable tickers, more macro data points have
  explanatory tooltips, Market Scan sources render as `Sources:` without a
  stray `- live`, and default visible scan columns follow the market/UI expert
  order. `AGENTS.md` now documents that beta is the source of truth and agent
  previews must sync/restart when clean or be explicitly marked stale.
  Verification: `npx tsc --noEmit` clean, `npm test` 97 files / 888 tests
  passed, `npm run build` clean, and an authenticated local production GET to
  `/` returned 200 with a complete response. In-app browser local visual smoke
  was blocked by the browser URL policy / local transport limits. See
  `docs/rollouts/2026-06-23-ui-expert-strategy-macro-errors.md`.
- 2026-06-23 (`HEAD` detached from `main`): **Green/Red LLM model routing.**
  Recovered the split-model setup that was present in a dirty `agent/codex`
  worktree without copying unrelated Alpaca/account edits. Strategy Studio now
  exposes a Green Team model and optional Red Team model; Settings ->
  Connections shows a read-only model summary beside provider key management.
  Red/Bear review uses
  `policy.redTeamLlmModel` when set and otherwise falls back to Green. The
  visible list removes legacy `gpt-4.1-mini`, adds `gpt-5.4`, gives Grok choices
  matching cost/strength labels, and records Grok pricing in the usage estimator.
  See `docs/rollouts/2026-06-23-green-red-llm-routing.md` and
  `docs/rollouts/2026-06-23-settings-connections-llm-setup.md`.
- 2026-06-23 (`HEAD` detached from `main`): **Accounts modal broker connect buttons.**
  Removed the separate top-level Robinhood MCP status card from Accounts so the
  modal now presents Robinhood, Alpaca, and Alpaca MCP as peer connect actions.
  The Robinhood MCP health check still runs silently to decide whether the
  Robinhood button should sync an authenticated session or start OAuth, but a
  configured-yet-unauthenticated endpoint no longer creates a disconnected
  account-like panel. See `docs/rollouts/2026-06-23-accounts-connect-buttons.md`.
- 2026-06-23 (`main`): **Beta hostname standardization.** Canonicalized the
  main integration preview hostname as `trading-beta.jays.services` for
  `~/Code/Agentic Trading` / pm2 `trading-main` / port `4001`; documented that
  no duplicate dev/beta hostname should be recreated in DNS, Tunnel ingress,
  Access apps, redirect-rule exclusions, or docs. Cloudflare state currently has
  DNS/Tunnel/Access only for `trading-beta.jays.services`, and unauthenticated
  public requests now reach the Cloudflare Access app instead of the old redirect.
  Also hardened `scripts/land.sh` with dirty-tree and stale-overlap guards so an
  agent branch cannot silently auto-merge stale UI/text/behavior over newer
  `origin/main` changes without deliberate review. Verification exposed Vitest
  discovering nested local agent workspaces under `.claude/worktrees`; `vitest`
  and `tsconfig` now exclude hidden tool-workspace directories so local
  verification is stable regardless of Claude/Codex/Cursor artifacts. See
  `docs/rollouts/2026-06-23-beta-domain-standardization.md`.
- 2026-06-22 (`feat/antigravity-cheap-wins`): **5 cheap-win risk/execution gates from re-verifying Antigravity's critiques.** After confirming #94/#95/#96 landed, shipped the remaining low-cost items where data/plumbing already existed but wasn't gated: (1) **volatility panic auto-brake** — VIX/VVIX/SKEW tail extreme flips `active`→`close_only` + kill-switch (new `evaluateVolatilityBrake` in `macro.ts`, wired in `runStrategyOnce`; default ON at VIX 40/VVIX 150/SKEW 160, configurable); (2) **ADV market-impact cap** — opening orders capped at `maxOrderPctOfAdv`% of daily $-volume in both `applyDeterministicSizing` and the `policy.ts` gate (default 5%); (3) **marketable-limit entries** — wired the dormant `marketableLimitEntries` stub in `enrichOpeningProposal` (notional→qty+limit through the quote by `marketableLimitBufferBps`, default 15 bps; default OFF/opt-in); (4) **Robinhood synthetic-stop transparency** — `[Risk]` note on non-bracket-broker opens (RH can't hold OCO via MCP; true RH stop-leg deferred); (5) **optional cross-provider Bear LLM** — `RED_TEAM_LLM_PROVIDER=anthropic` routes Red Team to Claude (`redTeamProvider()`/`debateViaAnthropic()`, default openai). Deliberately did NOT fold tax into the tuner (4b) — would penalize a Roth IRA's cost-free turnover (owner priority: Roth ≥ taxable). tsc clean · 881 tests (+new) · build green. Isolated worktree off `origin/main`; landing via PR. See `docs/rollouts/2026-06-22-antigravity-cheap-wins.md`.
- 2026-06-22 (`feat/grok-provider`): **xAI / Grok as an LLM provider option.** Provider is **derived from the
  model name** — a `grok-*` model routes to xAI (OpenAI-compatible, `api.x.ai/v1/chat/completions`) with the
  xAI key; any other model keeps the OpenAI path. New `src/lib/llm-provider.ts` `resolveLlmEndpoint(policy,
  userId)`; `db-api-keys` gains `xai` (`XAI_API_KEY` env map + aliases + `resolveLlmCredential("xai")` with
  operator failover + boot migration); `app/api/keys` catalog adds an "xAI (Grok)" row (data-driven keys UI);
  the 6 agentic LLM call sites (strategy Bull+Bear, red-team, tuning, revalidation, post-mortem) use the
  resolver + attribute the resolved `provider` in the usage ledger; model dropdown gains grok-4.3 /
  grok-build-0.1. **Default unchanged** (still OpenAI); making a cheap Grok the keyless default is deferred
  (set default model to `grok-build-0.1`). `.env.example` + `test/llm-provider.test.ts`. Code by a Sonnet
  subagent (I fixed a TDZ in post-mortem.ts). tsc clean, full suite green, build green. See
  `docs/rollouts/2026-06-22-grok-provider.md`.
- 2026-06-22 (`feat/per-user-llm-model-effort`): **Per-user LLM model + reasoning effort (gpt-5 support).** Model and reasoning effort are now per-user policy settings (`llmModel`, `llmReasoningEffort`; defaults `gpt-5.4-mini`/`medium`) with dropdowns in Settings — each user picks their own. `llm-request.ts` gained `isReasoningModel`/`resolveOpenAiModel`; `withLlmRequestBounds` now **omits `temperature` for gpt-5/o-series** (they 400 on it), sends `reasoning_effort`, and raises the output-token cap (low 2k/med 4k/high 8k) so reasoning tokens don't starve the answer. All 5 call sites resolve the per-user model + pass effort (`model` now required in bounds). Fixes the "project has no access to gpt-4.1-mini" error: the per-user default (gpt-5.4-mini) overrides the box `OPENAI_MODEL` via `mergePolicy`. Added policy validation, usage pricing for gpt-5.x, `.env.example` note, and `test/llm-request.test.ts`; pinned 4 bounds tests to gpt-4.1-mini. tsc clean · `npm test` 863 pass / 1 pre-existing unrelated fail · build green. See `docs/rollouts/2026-06-22-per-user-llm-model-and-effort.md`.
- 2026-06-22 (`claude/cloud-env-setup`): **Cloud/remote sandbox setup is now codified.** A Claude Code cloud agent hung for hours on "Setting up a cloud container" for this repo; investigation found the repo had **no** `.devcontainer`, no `setup`/`postinstall` in `package.json`, and an empty `.claude/settings.json`, so the cloud/remote "Run setup script" step was undefined. Added `.nvmrc` (`24`, matches local `v24.16.0`), `scripts/cloud-setup.sh` (idempotent `npm ci` + non-destructive `.env.local` seed; app boots keyless in Test mode/SQLite, secrets optional), and `.devcontainer/devcontainer.json` (Node 24 image → `postCreateCommand: bash scripts/cloud-setup.sh`, forwards :3000). Config/shell/docs only — no source touched (`bash -n` clean; `verify` CI runs the full tsc/test/build trio on the PR). **Owner action:** set the Cloud env setup-script field to `bash scripts/cloud-setup.sh` (files reach a cloud clone only after this merges, since cloud clones from GitHub). Per-environment launcher settings are app/account-UI only — not Claude-editable. See `docs/rollouts/2026-06-22-cloud-env-setup.md`.
- 2026-06-22 (`fix/autonomy-status-chip-label`): **Autonomy status chip clarity.** Header chip showed "Inactive" right after choosing Autonomous (it reflects run-state `systemState`, not the approval mode) — confusing. Relabeled: halted → **"Stopped"** (matches Start/Stop), active+decide → **"Running · Autonomous"**, active+propose → **"Running · Propose"**, setup → "Setup Needed", liquidating/close_only fallback kept. Behavior unchanged (choosing a mode never starts the system — Start is the gate). UI-only; tsc + build green. Deploy run #17 (PR #100) verified green; site 302. See `docs/rollouts/2026-06-22-autonomy-status-chip-label.md`.
- 2026-06-22 (`fix/accounts-active-badge-robinhood-card`): **Accounts tab — hide phantom Robinhood card + ACTIVE badge.** (1) The Robinhood MCP status card no longer renders unconditionally — only when `mcpHealth.configured`/`authenticated` or a connected `robinhood` account exists (default setup hid a non-functional "Not connected" card); the Connect buttons stay. (2) The account the app is set on now shows a green **ACTIVE** badge (active derived as `policy.connectedAccountId` else the `isActive` row), other connected accounts a muted **Connected** badge — was previously a single misleading "CONNECTED" on the active one only. AUTONOMOUS badge still rides the active account in decide mode. UI-only; tsc clean · build green. Also: verified prior batch deployed (Deploy run #16 green; site 302). See `docs/rollouts/2026-06-22-accounts-active-badge-robinhood-card.md`.
- 2026-06-22 (`fix/ux-account-authority-watchlist`): **UX fixes + watchlist self-heal bug.** (1) Consent dialog: dropped contradictory "One-time choice"; (2) account dropdown no longer doubles the env suffix ("Alpaca (Paper) (paper)" → "Alpaca (Paper)" — omit `(environment)` when the label already contains it); (3) strategy-authority labels renamed user-facing "Decide" → "Autonomous" (values `propose`/`decide` unchanged) across dropdowns/confirms/subtitle/help/tooltip; (4) **root-cause bug**: `PUT /api/policy` 400'd the whole policy on any unsupported symbol, and since the client re-sends the full policy a stale `BTC` in `additionalSymbols` bricked *every* update (why Autonomous toggle failed) — now `sanitizeSymbolList()` normalizes+drops unsupported symbols (equity-only) instead of erroring (self-heals); broker `getAccounts()` wrapped in try/catch (no raw 500/HTML); client `updatePolicy` never toasts HTML bodies. Add-time validation in Settings kept. tsc clean · policy tests 42/42 · `npm test` 855 pass / 1 pre-existing unrelated fail (`cache-provenance`) · build green. Owner: delete the stale Alpaca paper account via Accounts → Remove. See `docs/rollouts/2026-06-22-ux-consent-account-authority-watchlist.md`.
- 2026-06-22 (`sim/funded-test-account`): **Funded local simulator for the Test broker.** `TestBrokerGateway`
  (`robinhood.ts`) returned a $0 unfunded portfolio (buying power 0 → couldn't simulate trades); now it is a
  **funded local simulator** — starting balance via `TEST_SIM_STARTING_CASH` (default $100k), positions/P&L
  derived from recorded sim fills (`getOpenLots` + live quotes; equity = starting cash + paper realized +
  unrealized, cash = equity − positions value). Account label → **"Test — Local Sim"**; `getTestGateway(userId)`
  threaded through `broker.ts`. Dashboard TEST banner + `strategic-framework.md` + `/strategy` now state a
  third-party paper account (e.g. Alpaca Paper Trading) is **likely more realistic** than the local sim. New
  `test/test-sim-funded.test.ts` (no-fills baseline = $100k). Code by a Sonnet subagent (owner decision: option A
  of the test-account tree). See `docs/rollouts/2026-06-22-funded-test-sim.md`.
- 2026-06-22 (`feat/seo-landing-prep`): **Launch prep — SEO foundation (noindex by default) + flag-gated
  landing page + GTM docs.** Prepared for a possible public launch without exposing anything: full SEO
  `metadata` + `app/robots.ts` (disallow-all) + `app/sitemap.ts`, all noindex until
  `NEXT_PUBLIC_ALLOW_INDEXING=true`; compliant education-led `app/welcome/page.tsx` gated by
  `LANDING_PAGE_ENABLED` (default off → 404) with disclosures + JSON-LD; `/welcome` in middleware
  `PUBLIC_PREFIXES`; env in `.env.example`. Also: a public `/strategy` overview page (honest, derived
  from `docs/strategic-framework.md`, linked from the landing); paper-trading wording fixed to "via a
  third-party connection (e.g. Alpaca Paper Trading)" + a "Test — Local Sim is less realistic" note; and
  a `buttonClass()` helper so CTAs are styled `<a>`s (no `<button>` in `<a>`). Positioning (from the
  2026-06-22 deep-research run): market as research/paper/education, not "AI trades your money". Code by
  Sonnet subagents. tsc clean, 807 tests, build green.
  See `docs/go-to-market.md` + `docs/rollouts/2026-06-22-seo-landing-prep.md`.
- 2026-06-22 (`agent/claude-h-core` + `agent/claude-h-learn` + `agent/claude-h-trig`): **Strategy/risk/execution hardening — 3 sibling PRs** ([#94](https://github.com/jaywedgeworth22/agentic-trading/pull/94)/[#95](https://github.com/jaywedgeworth22/agentic-trading/pull/95)/[#96](https://github.com/jaywedgeworth22/agentic-trading/pull/96)) from the verified-actionable subset of Antigravity's strategy critique, re-scoped to the app's real posture (multi-user, real sizes, shorting in scope — not a $10 paper toy). **CORE**: shorting enablement (default OFF, `shortSellingEnabled` + account-capability gated via `allowedProposalSides`), `maxPortfolioBeta` cap, entry-drift guard (`maxEntryDriftPct`, default 10, on `TradeProposal.referencePrice`), model-free FCF-yield/debt-equity hard-veto in `deterministicBearFilter`, broker-held OCO brackets on Alpaca (`enrichOpeningProposal`, `brokerBracketsEnabled` default on), beta-scaled stops (`betaScaledStopPct`), removed dead `RiskRules.stopLossAtrMultiple`; Settings UI + `/api/policy` validation. **LEARN**: OOS walk-forward-gated weight patches (wires existing `runWalkForwardOOS` into `proposeStrategyTuning`), regime-segmented tuning evidence, read-only holding-period/turnover scorecard fields, execution-cost model ON by default (1 bps, env opt-out). **TRIG**: TradingView webhook submits a `technical` material event into the trigger engine (`src/lib/tradingview-trigger.ts`). All three: tsc clean, full suite green, `npm run build` green; merged `origin/main` (consent-pool #91 + email-aliases #92). Deferred: marketable-limit entries (notional-routing conflict), true ATR stops (needs OHLC feed), per-regime weight matrices. See `docs/rollouts/2026-06-22-risk-shorting-hardening.md`, `-learning-loop-hardening.md`, `-tradingview-trigger-wiring.md`.
- 2026-06-22 (`feat/primary-email-aliases`): **Primary email aliases — one operator, many addresses.** New `PRIMARY_USER_EMAIL_ALIASES` env (comma-separated): every listed address maps to the single primary `"local"` account, so the owner can sign in with any of their emails (Gmail + custom-domain) onto the same identity/data, all auto-allowed + admin. `identity.ts` `primaryEmails()` (call-time) drives `isPrimaryEmail`/`userIdForEmail`/`isEmailAllowed`; `middleware.ts` mirrors the set at the edge; `admin.ts` `isAdminEmail` now delegates to `isPrimaryEmail`. No data migration (all map to `"local"`). tsc clean · auth tests 14/14 · `npm test` 805 pass / 1 pre-existing unrelated fail (`cache-provenance`, date-sensitive) · build green. Owner sets on prod `.env.local`: `PRIMARY_USER_EMAIL=jaywedgeworth22@gmail.com`, `PRIMARY_USER_EMAIL_ALIASES=mail@jaywedgeworth.com,mail@jays.services`, then `pm2 restart trading --update-env` (+ allow all three in the CF Access policy). See `docs/rollouts/2026-06-22-primary-email-aliases.md`.
- 2026-06-22 (`feat/robinhood-data-consent-pool`): **Robinhood public data → consent pool.** RH-acquired bars + fundamentals (public market data, not account-private info) now flow into the reciprocal consent pool like every other user-keyed source, instead of being hard-`private`. `history.ts` RH OHLC tier scope `"private"` → `cacheScopeForKeySource("user", userId)` (pool with consent, else private); `RobinhoodEnrichmentProvider` (`data-providers.ts`) gains the same consent-aware `readEnrichmentCache`/`writeEnrichmentCache` as the other providers. RH OAuth token stays strictly per-user (PR #54) — only the public data is shared, only with consent (refuse → private + excluded). New `test/robinhood-data-pool.test.ts` (3 tests): consenting users share RH bars+fundamentals via the pool (no second broker call); non-consenters stay private. tsc clean, **807 tests** (+3), build green. Built in `~/apps/trading-rh-pool` off `origin/main`; landing via PR. See `docs/rollouts/2026-06-22-robinhood-data-consent-pool.md`.
- 2026-06-22 (`docs/deploy-handoff`): **Production auto-deploy is LIVE + backfilled handoff docs.** `.github/workflows/deploy.yml` deploys every push to `main` (and manual dispatch) to the self-hosted PM2 box via a `trading-live`-labeled runner on the owner's M-series Mac: token-auth `git fetch` → `git reset --hard FETCH_HEAD` → `npm ci` → `npm run build` → `pm2 restart trading`. Activated/debugged across PRs #79 (move into `.github/workflows/`), #81 (fetch via `GITHUB_TOKEN` — launchd runner has no git creds/TTY), #82 (`reset --hard FETCH_HEAD` not `checkout main` — `trading-live` is a linked worktree sharing the `main` checkout). Deploy run #6 green; `trading.jays.services` serves HTTP 302 (auth gate) = up. This change backfills the skipped handoff: new `docs/deployment.md` runbook, new `docs/rollouts/2026-06-22-deploy-workflow-activated.md`, and `ci-pending/README.md` deploy section corrected to the real design. Owner note: live `/access-denied` just means the visitor email isn't allowlisted (`PRIMARY_USER_EMAIL`/`ADMIN_USER_EMAILS`/CF Access) — not a deploy bug.
- 2026-06-22 (`ci/activate-e2e`): **Activated the Playwright smoke workflow.** `git mv
  ci-pending/e2e.yml .github/workflows/e2e.yml` — the smoke (`npm run test:e2e`, now passing after
  `e2e/smoke-fix`) runs on every PR/push. Reframed `ci-pending/README.md` from "staged" to reference
  (all of ci/security/e2e/deploy are now active; `ci-pending/` holds only the README). To make the
  smoke a *required* merge gate, add its check context (`smoke`) to the `main-protection` ruleset's
  required checks. See `docs/rollouts/2026-06-22-activate-e2e-workflow.md`.
- 2026-06-21 (`fix/per-user-robinhood-enrichment-token`): **SECURITY — Robinhood broker-token tenant isolation in the read-only enrichment paths.** Audit of PR #42 (`0056f04`, per-user OAuth token) found two enrichment callers fetched Robinhood data with no userId, falling through to `DEV_USER_ID` (`'local'`) and silently using the operator's real broker token for every user. Fix: `fetchRobinhoodHistoricals`/`fetchRobinhoodFundamentals` (`robinhood.ts`) now require an explicit `userId` (no `DEV_USER_ID` default); `fetchDailyOHLC` (`history.ts`) consults the private Robinhood OHLC tier ONLY when a user is in scope and forwards it (the computed-technicals refresh writes a GLOBAL dataset → omits the broker tier, never borrows `'local'`); `RobinhoodEnrichmentProvider` (`data-providers.ts`) takes the request-scoped userId and fails closed when none. Also folded in: the OAuth callback now asserts the completing session's userId matches `stateBlob.userId` (`completeMcpOAuthCallback` `expectedUserId`) so a token can't be bound under a victim's userId. New `test/robinhood-tenant-isolation.test.ts` (7 tests) pins user B never resolving user A's token. tsc clean, **674 tests** (+7), build green. Built in the isolated `~/apps/trading-fix-rh-token` worktree off `origin/main` (the `agent/claude` lane was parked on `agent/claude-litestream`); landing via PR. See `docs/rollouts/2026-06-21-robinhood-enrichment-token-isolation.md` and the "Post-merge hardening" section of `docs/design/per-user-broker-token.md`.
- 2026-06-22 (`e2e/smoke-fix`): **Fix Playwright smoke (prod-mode auth) + drop transactional
  fill+snapshot.** Smoke failed because `next start` runs `NODE_ENV=production`, so the auth
  middleware redirects `/`→`/access-denied` (dashboard never renders). `playwright.config.ts` now
  authenticates the test browser via the CF-Access header (`CF_ACCESS_TRUST_EMAIL_HEADER=1` +
  `extraHTTPHeaders`); also refreshed the stale `Kill|Resume`→`Start|Stop` assertion. e2e.yml
  activation still needs a `workflow`-scoped token (owner; like deploy.yml). **Dropped transactional
  fill+snapshot** — not safe: each write is a single atomic INSERT, snapshots already bracket the run
  (pre+post), coupling a real-broker fill to a snapshot write would roll back a real trade, and the
  CAS + synthetic-stop claim already guard double-book. See `docs/rollouts/2026-06-22-e2e-smoke-auth-fix.md`.
- 2026-06-22 (`safety/fk-cleanup`): **FK enforcement + account-delete cascade cleanup.** Deleting a
  connected account left orphaned `fill_events`/`portfolio_snapshots`/`trade_proposals`/
  `synthetic_trailing_stops` still feeding P&L/exposure. `getDb()` now sets `PRAGMA foreign_keys=ON`
  (inert today, correct default), and `deleteConnectedAccount` purges the account's records (by
  `account_number`+`user_id`) in one transaction. Behavioral change: removing an account now purges
  its trade/P&L history. tsc clean, 794 tests (+3), build green. See
  `docs/rollouts/2026-06-22-fk-account-delete-cleanup.md`.
- 2026-06-22 (`reliability/llm-timeout`): **Bounded LLM + Robinhood-order fetch timeouts.** LLM HTTP
  calls and the Robinhood MCP order path had no timeout — a half-open connection could hang the caller
  indefinitely (and hold the per-user strategy run lock). New `llmFetch()` + `LLM_TIMEOUT_MS=60s` in
  `llm-request.ts`, applied to bull/bear (`strategy.ts`), `red-team`, `strategy-tuning`,
  `proposal-revalidation`, `post-mortem`, and `chat/llm` (Anthropic+OpenAI); `callRobinhoodMcpMethod`
  gets `AbortSignal.timeout(30s)` (covers `place_equity_order`). tsc clean, 791 tests (+3), build green.
  See `docs/rollouts/2026-06-22-llm-fetch-timeout.md`.
- 2026-06-22 (`reliability/scheduler-cadence`): **Scheduler cadence rehydrate on boot.** The scheduler
  fired a run on the first tick after every restart/HMR/deploy regardless of cadence (in-memory
  `userSchedules.lastRunAt` starts null). Now seeds `lastRunAt` from the last real `strategy_runs` row
  via new `getLastStrategyRunStartedAt(userId)`, so cadence survives a restart. tsc clean, 790 tests
  (+3), build green. NOTE: dropped the queued `fill_events UNIQUE(proposal_id, source)` idempotency —
  invalid key (proposals legitimately have multiple fills; broke 26 tests) and the execution CAS
  already guards the double-book. See `docs/rollouts/2026-06-22-scheduler-cadence-rehydrate.md`.
- 2026-06-22 (`feat/llm-usage-key-labels`): **Human-readable per-key LLM usage labels.** `describeUsageKey(row)` (`llm-usage.ts`) maps a usage row's opaque `key_ref` fingerprint back to a **last-4 + label** from the live key store (own key → `"<userId> (<provider>)"`; `local` → `"operator (<provider>)"`; tenant on the env failover → `"operator env (<provider>)"`; detached key → undefined). `GET /api/admin/llm-usage` rows now carry `keyLabel` + `keyLast4`. Last-4 is computed at read time, never persisted (the ledger still only stores the non-reversible fingerprint). tsc clean, **788 tests** (+1), build green. Built in `~/apps/trading-keys3` off `origin/main`; landing via PR. See `docs/rollouts/2026-06-22-llm-usage-key-labels.md`.
- 2026-06-22 (`feat/alpaca-shared-data-per-key-ledger`): **Per-attached-key LLM ledger + Alpaca paper key as shared market-data source.** (1) The `llm_usage` ledger now records a non-secret `key_ref` (`keyFingerprint` = truncated sha256) so usage/cost is measured **per attached key** (user or operator), not just per source; `resolveLlmCredential` returns `keyRef`, threaded through every LLM site, grouped in `getLlmUsageSummary` at `GET /api/admin/llm-usage`. (2) New `resolveAlpacaMarketData(userId)` — a user's own Alpaca key gives individual data (private/pooled); otherwise the operator's paper key serves as the **shared** market-data source for background scans (no userId) + tenants without their own key. Trading stays strictly per-user (`alpaca.ts` unchanged) so no one trades on the operator's account; Alpaca data is identical paper/live. Restores the real-time Alpaca enrichment tier for background scans (had degraded after PR #65). Robinhood-as-global-data considered + declined (no edge, undocumented account-scoped caps, ToS risk). `key_ref` schema added as a versioned migration (v2) per the new `MIGRATIONS` framework. tsc clean, **766 tests** (+3), build green. Built in isolated `~/apps/trading-keys2` off `origin/main` (PR #65 merged); landing via PR. See `docs/rollouts/2026-06-22-per-key-ledger-and-shared-alpaca-data.md`.
- 2026-06-21 (`safety/persistence-hardening`): **Migration framework + money/data-loss fixes.**
  From the post-fix "what's left" re-audit; rebuilt onto the split `db.ts` + next16/zod4. Adds a
  `PRAGMA user_version` migration framework (`runMigrations`/`getSchemaVersion`; `migrate()` stays the
  idempotent baseline, next schema change goes in `MIGRATIONS`); an **ENCRYPTION_KEY boot fail-fast**
  (`assertEncryptionKeyAvailable` throws if the ephemeral random key would silently decrypt stored
  creds to `''`); **no fabricated `$100`** in Alpaca review (`estimateReviewNotional` fails closed;
  `getEquityQuotes` logs swallowed errors); **side-aware universe/blocklist gate** (sell/cover exits
  never blocked); **synthetic-stop live exits booked `pending_reconciliation`**. tsc clean, 772 tests
  (+8), build green. CI workflow activation is PR #50. See
  `docs/rollouts/2026-06-21-persistence-safety-hardening.md`.
- 2026-06-21 (`feat/per-user-key-resolution`): **Multi-user API-key resolution (no special `local`) + operator-funded LLM failover with per-user usage tracking.** `resolveApiKeyWithSource` (`db-api-keys.ts`) is tier-aware: **per-user-only** keys (broker `alpaca_*` + LLM `openai`/`anthropic`, and any unlisted service) have **no env fallback for anyone** — at boot the operator's env values are migrated into the `local` primary user's store (`migrateLocalEnvCredentials`/`migrateLocalRobinhoodToken` via `instrumentation.ts`), so every user incl. `local` resolves from their own stored keys/OAuth; **shared-operator-infra** keys (all market data, FRED, Pinecone/Voyage, Apify, SEC UA) keep a global env fallback (operator-funded public data; a user's own key still overrides + joins the consent pool). LLM uses `resolveLlmCredential`: per-user key first, else the operator env key as a **flag-gated failover for any user** (`LLM_OPERATOR_FALLBACK`, default on) — every call recorded in a new `llm_usage` ledger (`llm-usage.ts`, tokens/cost/keySource) at `GET /api/admin/llm-usage`. Closed direct-`process.env` bypasses (`alpaca.ts`, `mcp-oauth.ts`, `massive-s3.ts`, `congress.ts`) + threaded userId through the chat orchestrator and learned-context semantic gate (adversarial-review fixes — were silently spending the operator LLM key unattributed). tsc clean, **763 tests**, build green. Built in isolated `~/apps/trading-keys` off `origin/main`; landing via PR. See `docs/rollouts/2026-06-21-per-user-key-resolution-llm-ledger.md`.
- 2026-06-21 (`agent/claude-docs-pr-policy`): **Corrected AGENTS.md (PR policy + db.ts split + stale counts).** Documented the required `verify` CI check (ruleset-enforced; `--admin` does NOT bypass; merge with `--squash --auto`), repointed the daily-notional trap to `db-execution.ts` + added a note that `db.ts` is now an 8-module barrel, refreshed the test count (~723/81), and fixed the backwards AGENTS.md↔CLAUDE.md symlink description. See `docs/rollouts/2026-06-21-agents-md-pr-policy-fix.md`.
- 2026-06-21 (`agent/claude-litestream-dedup`): **Removed dead Litestream stub.** Deleted `scripts/litestream.mjs` + the 3 `litestream:*` npm scripts + the old `LITESTREAM_DB_PATH`/`LITESTREAM_REPLICA_URL` env vars (never run); reconciled `docs/ops-observability-security.md` to the live PM2+R2 setup. Single Litestream implementation now (the verified-live one from #47). tsc clean, 723 tests pass, build green. See `docs/rollouts/2026-06-21-litestream-dedup.md`.
- 2026-06-21 (`agent/claude-flaky-lock`): **Fix flaky CI timeout in `approval-lock.test.ts`.** The two tests that let `executeProposal` run its full broker-review path (no broker → retry/backoff > 5s on loaded CI runners) got a 20s per-test timeout; they assert lock behavior, not timing. Stops intermittent `Test timed out in 5000ms` failures that were blocking PR merges. tsc clean, 4/4 pass. See `docs/rollouts/2026-06-21-flaky-approval-lock-timeout.md`.
- 2026-06-21 (`agent/claude-db-split-v2`): **refactor(db): split db.ts (2964 lines) into 8 focused modules.** Pure mechanical extraction — db.ts retains schema/migration/getDb()/audit() and re-exports all 8 modules as a barrel for zero consumer breakage. Re-derived from current main (supersedes stale PR #46). tsc clean, 704/704 tests green, build green. See `docs/rollouts/2026-06-21-db-split-v2.md`.



- 2026-06-21 (`agent/claude-litestream`): **Litestream WAL replication LIVE on Cloudflare R2 (P2-5).** Litestream 0.5.12 installed and running as PM2 sidecar `litestream` via `scripts/run-litestream.sh`, replicating `~/apps/trading-live/data/app.db` → R2 bucket `trading-live-backups`. First ~9.4 MB snapshot verified uploaded; `replica sync` each second, restart_time 0. 0.5.x is single-replica (dropped the local-file replica) and uses `litestream ltx` (not `snapshots`). PR #47. **Follow-up: rotate the R2 token (pasted in chat; scoped to that one bucket).** See `docs/rollouts/2026-06-21-litestream-r2-live.md`.
- 2026-06-21 (`feat/csrf-rate-limit-admin`): **SECURITY-HARDENING — CSRF origin guard + per-user rate limiting + admin-role gate.** Added `src/lib/auth/csrf.ts` (same-origin Sec-Fetch-Site/Origin check, wired into `middleware.ts` for state-changing `/api/*`; webhooks/health exempt), `src/lib/rate-limit.ts` (in-process sliding window, no deps; fail-open on error, 429 over limit; applied to OAuth start/callback, `orders/cancel`, `proposals/[id]/approve`), and `src/lib/auth/admin.ts` `requireAdmin` (ADMIN_USER_EMAILS allowlist + primary operator, default-deny in prod; composes with the legacy x-admin-token/non-prod gate; wired into all six `app/api/admin/*` routes). tsc clean, 642 tests pass (+19), build green. See `docs/rollouts/2026-06-21-csrf-rate-limit-admin.md`.
- 2026-06-21 (`agent/claude`): **P0-3/P1-2/P1-7 — VIX Yahoo fallback + congress floor + exposure defaults.** Live ^VIX from Yahoo Finance (key-free) replaces "Unknown regime" when no FRED key is configured; `hasNotableWebSignal` now requires buyCount≥2 AND netSignal≥2 (single-member disclosures no longer trigger rank-lift); `maxGrossExposurePct`/`maxNetExposurePct` defaults tightened 100→80 to enforce a 20% cash buffer. tsc clean, 593 tests all pass (+20). See `docs/rollouts/2026-06-21-p1-macro-signal-exposure.md`.
- 2026-06-22 (`claude/app-strategic-framework-xh9bdw`): **Staged production deploy workflow.** Added `ci-pending/deploy.yml` (auto-deploy `main`/merged PRs + manual dispatch → self-hosted PM2 host: `git reset --hard origin/main` → `npm ci` → `npm run build` → `pm2 restart trading`, preserving untracked `.env.local`/`data/`) and expanded `ci-pending/README.md` with activation, self-hosted-runner setup, and an SSH alternative. Staged in `ci-pending/` because the push token lacks `workflow` scope. Owner must `git mv` it into `.github/workflows/` + register the `trading-live` runner (or set SSH secrets) to activate. See `docs/rollouts/2026-06-22-deploy-workflow-staged.md`.
- 2026-06-21 (`claude/app-strategic-framework-xh9bdw`): **Ticker logos default to transparent + tile-monogram fallback.** `DEFAULT_TICKER_LOGO_DISPLAY` `tile`→`transparent`; `TickerLogo` now renders a tile monogram (first 1–2 letters) when a logo image fails to load instead of a bare gap (explicit `fallback` prop still wins). Addresses a user report; the separate "Logo source (GitHub/logo.dev) picker does nothing" complaint was already fixed on `main` (commit `e61ec84` removed the picker; deterministic GitHub→logo.dev cascade) and only needs a deploy. tsc clean · `ticker-logos` test updated & green · `npm test` 647 pass / 1 pre-existing unrelated fail (`cache-provenance`, date-sensitive) · build clean. See `docs/rollouts/2026-06-21-ticker-logo-transparent-default-tile-fallback.md`.
- 2026-06-21 (`claude/app-strategic-framework-xh9bdw`): **Plain-English strategic-framework doc.** Added `docs/strategic-framework.md` — a college-level, no-investing-experience-assumed outline of the whole strategy (three execution modes, six evaluation lenses, factor weighting matrix, learning loop, safety gates) with an explicit honest weaknesses/limits/risks section (unproven factor weights, no rigorous backtester, free-tier data gaps, keyword sentiment, advisory-only weight shifts + 20-trade cold start, short/cover not fully proven, single-process scheduler, no holiday calendar). Living doc with its own changelog; update it as the strategy is refined. Docs-only. See `docs/rollouts/2026-06-21-strategic-framework-plain-english.md`.
- 2026-06-21 (`agent/claude`): **P1-4/5/6 — congress disclosedAt windowing + scorecard floor + deterministic Bear veto.** PR #35.
- 2026-06-21 (`agent/claude`): **Best-source precedence + source/time provenance tooltips.**
  Reordered the enrichment cascade so the real-time `AlpacaSnapshotEnrichmentProvider` wins the
  price-family fields (price/bid/ask/volume/vwap/intradayChangePct) over delayed providers (it only
  supplies market data, so fundamentals sourcing is untouched; self-skips without Alpaca keys). Added
  a shared `dataPointTitle(label, source, asOf)` (+ `derivedTitle`) so hovering ANY Market-Scan cell
  shows `Source: <provider> · Received HH:MM`, attributed to that field's own `sources[field]`
  (derived cols → "Computed from <inputs>"; no-provenance cols → time only; never fabricated).
  `StatTile` carries source/time app-wide; `SOURCE_LABELS` polished (alpaca-snapshot→"Alpaca"). tsc
  clean · **593 tests** · adversarially verified · see
  `docs/rollouts/2026-06-21-best-source-and-provenance-tooltips.md`.
- 2026-06-21 (`agent/claude`): **Scan default columns (expert panel) + Alpaca VWAP/feed.**
  A 4-persona financial-expert panel chose a new 11-column execution-aware default for the Market
  Scan — `symbol·price·Chg·vsVWAP·SecRS·%offHi·$Vol·Spread·Bid·Ask·Score` (bid/ask now default-on
  per owner mandate; `SCAN_COLS_KEY`→v3). Alpaca snapshot provider now also maps real **VWAP**
  (lights the existing "vs VWAP" column) and the data feed is env-configurable (`ALPACA_DATA_FEED`,
  default `iex`; SIP is 403 on the free plan). Also fixed 5 tsc errors another lane left in
  `test/deterministic-bear.test.ts`. tsc clean · **580 tests** · live VWAP verified · see
  `docs/rollouts/2026-06-21-scan-default-columns-alpaca-vwap.md`.
- 2026-06-21 (`agent/claude`): **P1 edge quality — congress disclosedAt windowing + scorecard noise floor + deterministic Bear veto.** Three financial-expert-panel P1 items: (1) `aggregateCongressSignals` now windows on `disclosedAt` (not `tradedAt`) so only market-visible disclosures count; (2) LLM scorecard filters raised ≥2→≥5 trades; (3) `deterministicBearFilter` (sync, no LLM) runs before Bear: hard-vetos phantom exits + below-median buys in crisis regime, flags momentum overextension. tsc clean, 573 tests (+16). Commit: `61b560e`. See `docs/rollouts/2026-06-21-p1-edge-quality.md`.
- 2026-06-21 (`agent/claude-ui`, PR pending): **UI/UX deferred-fix pass.** Cleared a batch from
  the issue register: Strategy-Flow rework (REL-6), safe-area insets (IPH-9/IOS-1), dark-mode
  danger contrast (A11Y-7), scoped chart gradient (MISC-1), deleted dead `app/ui/dashboard/*`
  (DUP-1, also closing CPY-7/VIS-2), safety-banner casing (CPY-9), Activity aria (A11Y-5),
  pill-label sizes (A11Y-8), scan-table overscan (SCN-2). Done in an isolated worktree off `main`
  to avoid racing the live `agent/claude` session. tsc clean · **557 tests** · build clean · see
  `docs/rollouts/2026-06-21-ui-ux-deferred-fixes.md`.

- 2026-06-21 (`agent/claude`, PR #32): **PDT-rule repeal + Alpaca scan data + consent UI.**
  FINRA Notice 26-10 retired the Pattern-Day-Trader rule ($25k / 4-trades-in-5-days) → replaced
  the `policy.ts` PDT gate with a `MARGIN_MINIMUM_EQUITY` ($2,000) margin-account gate (LIVE +
  `marginEnabled` + equity < $2k, opening legs only); day-trade counting kept but now informational.
  New `AlpacaSnapshotEnrichmentProvider` feeds real bid/ask/price/volume/intraday-change into the
  Market Scan (replacing fabricated spreads), consent-gated, verified live against the linked paper
  account. Settings gained a "Data" tab that states the shared-pool deal + a consent toggle
  (`GET/POST /api/consent`). tsc clean · **557 tests** · see
  `docs/rollouts/2026-06-21-pdt-repeal-alpaca-scan-consent-ui.md`.

- 2026-06-21 (`safety/deep-fixes`): **Execution-section CAS + synthetic-stop re-entrancy + boot
  autonomy interlock.** Three failure-mode-review deep fixes (the auth middleware #1, the drawdown
  circuit breaker #7, and the approval-path run-lock were already on `main`). Adds an atomic DB
  compare-and-swap (`claimProposalForExecution`) at both `executeProposal` commit points — defense in
  depth alongside the existing run-lock so concurrent/retried approvals can't double-place; the
  synthetic-stop monitor now claims each stop (`claimSyntheticStop`/`revertSyntheticStopClaim`) +
  a `globalThis`-pinned per-user in-flight guard in the scheduler (deterministic refId for broker
  dedupe); and `reconcileAutonomyOnBoot()` reverts persisted `active` autonomy to `halted` on boot
  unless `AUTONOMY_RESUME_ON_BOOT=1`. tsc clean · tests green (+8) · build green. See
  `docs/rollouts/2026-06-21-execution-cas-and-boot-interlock.md`.
- 2026-06-21: **Responsive UI spacing and sizing tweaks.** Stretched selects and text fields to be max-sm:h-11 on mobile device headers, constrained widths to prevent layout breaking, and aligned header elements cleanly.
- 2026-06-21: **Proposal UI refinements, account details, and text contrast improvements.** Updated the proposed decisions card inside `DecisionView` to display a custom bold, smaller `TEST` label instead of the green chip for paper test status. Plumbed the connected account details (`Agentic x####`, `Brokerage x####`, `Paper x####`) to the top-left of each proposal card. Surfaced ticker logos directly in the proposal boxes beside the ticker. Hardened text contrast by changing size/cost labels to `text-fg font-medium` and rationale text to `text-fg/85`. Customised the portfolio panel and mobile summary titles to indicate the specific broker/environment (e.g., `Alpaca Paper Account` or `Robinhood Agentic Account`). Verified all 416 unit tests, type check, and Next.js build pass cleanly.
- 2026-06-21: **Responsive header layout, logo options, and ticker validation.** Redesigned the header component to stack cleanly as `flex-col` on mobile/tablet and `lg:flex-row` on desktop, preventing overlap with the top safety banner. Aligned the green Zap logo to the top of the title text. Renamed autonomy status `"Halted"` to `"Inactive"`. Changed Settings subtitle to `"Risk, Tax, & Notifications"`. Renamed Ticker logo options to "Small Tile" and "Medium". Integrated logo source selection ("Option 1: Auto", "Option 2: GitHub only", "Option 3: logo.dev only") with backend routing. Added symbol validation to Watchlist, Additional Watchlist, and Ignore List (Blocklist) to restrict input to valid S&P 500, Nasdaq 100, and Dow 30 components. Passed all 416 unit tests, Next.js build, and type check.
- 2026-06-21 (`claude/pr-ready-by-default-convention`): **PR convention codified in `AGENTS.md`.** Every branch meant for `main` gets a PR, and PRs open **ready for review by default — not drafts** (this repo has no required CI/branch protection and a sole approver, so a draft only adds a "mark ready" step with no protection). Draft is reserved for genuine WIP, flagged in the PR body. This overrides the harness default of opening PRs as drafts. Docs-only; new "## Pull requests" section in `AGENTS.md`. See `docs/rollouts/2026-06-21-pr-ready-by-default-convention.md`.
- 2026-06-21 (`agent/claude`): **Deferred backlog continuation (multi-agent, autonomous).** Worked the remaining panel backlog in the isolated `~/apps/trading-claude` worktree using background agents (sonnet) on disjoint files + inline money-path work, committing + ff-merging each chunk to `main`. Landed: macro Unknown-regime, not-advice disclaimers (chat + Decision surface), real SEC EDGAR UA, pinned Score column, **factor orthogonalization** (tanh momentum + less double-counting), **clientOrderId broker-truth reconcile** (recovers a crashed-mid-placement order from the broker — completes the atomic-placement loop), **evidence-floor sizing** (unproven theses sized at the floor, not 28%), and a **per-tick pending-fill reconciler** (Robinhood). tsc clean, **456 tests**. Remaining (next session): run-lock approval path, native Alpaca brackets, PDT/Reg-T gate, migration ledger, db.ts split, Litestream, Robinhood fundamentals. See `docs/rollouts/2026-06-21-deferred-continuation-multiagent.md`.
- 2026-06-21: **Short/cover broker-side translation (money-path).** Broker adapters forwarded our 4-value `OrderSide` raw to buy/sell-only broker APIs, so a live `short`/`cover` was invalid (and the synthetic-stops engine emits `cover` outside the policy gate). New `src/lib/broker-side.ts` (`toBrokerSide`: short→sell, cover→buy); `alpaca.ts` translates on both order paths (Alpaca supports shorting, still gated by `shortSellingEnabled`); `robinhood.ts` `toMcpOrder` fails closed (throws on short/cover — no equity shorting). 423 tests (new `test/broker-side.test.ts`, incl. Alpaca SDK-mocked end-to-end), tsc + build clean. Built in isolated worktree off clean `main`; landing via PR. Rollout: `docs/rollouts/2026-06-21-short-cover-broker-side-translation.md`.
- 2026-06-21: **Auth hardening — strip client identity headers on public routes.** The `middleware.ts` PUBLIC_PREFIXES branch (`/api/health`, `/api/webhooks`) forwarded requests unchanged, so a forged `x-authenticated-user-email`/`x-user-id` could pass to a public handler. New edge-safe `src/lib/auth/strip-identity.ts` (`stripClientIdentityHeaders`); both middleware branches now strip identity before forwarding (public stays unauthenticated — webhooks unaffected). Not exploitable today; closes the latent footgun. 459 tests (new `test/strip-identity.test.ts`), tsc + build clean. Isolated worktree off clean `main`; landing via PR. Rollout: `docs/rollouts/2026-06-21-strip-identity-public-routes.md`.
- 2026-06-21: **Git author identity rule (GitHub email privacy).** Codified in `AGENTS.md`: all commits/pushes use the owner's GitHub noreply email (`12656028+jaywedgeworth22@users.noreply.github.com`), never the real email. Repo-local `user.email` already set repo-wide (all worktrees inherit via shared `.git/config`; global stays the real email for other repos). Rollout: `docs/rollouts/2026-06-21-git-email-identity-rule.md`.
- 2026-06-21 (`agent/claude`): **Deferred-task sweep — P0 safety re-application + IC backtest + buying-power gate.** Worked the financial-expert-panel backlog in the ISOLATED `~/apps/trading-claude` worktree. Landed: (1) `bddaa35` the full P0 safety slice — size-less-exit reject + full-position resolve, fail-closed Red Team (`available` flag + 45s timeout → human review), atomic crash-recoverable order placement (`placing` intent row + `ref_id` persistence + run-start stale sweep) on both autonomous + approval paths, account-level drawdown/daily-loss kill-switch (`src/lib/risk-breaker.ts`), real `/api/health` probe + scheduler heartbeat, SSE per-tenant filter (+12 tests); (2) `4ea77a8` an IC backtest harness (`src/lib/backtest.ts` — Spearman factor ICs over `signal_snapshot` audits → advisory IC-derived weights, dev-gated `GET /api/admin/backtest-ic`, +10 tests); (3) `71698a5` a buying-power affordability gate (+4 tests). tsc clean, **441 tests**. Restored the wiped panel review doc (`docs/reviews/2026-06-21-financial-expert-panel.md`). **Hand off:** merge `agent/claude` → `main` deliberately. Remaining (staged in the rollout note): cost model, PDT gate, clientOrderId broker-truth sweep, native brackets, factor orthogonalization, real macro feed, P3 polish. See `docs/rollouts/2026-06-21-deferred-tasks-p0-backtest.md`.
- 2026-06-21: **Logo source toggle + logo.dev integration.** Added logo.dev as a cascade fallback behind GitHub in the `/api/logos/ticker` proxy. Client detects dark/light mode via MutationObserver and passes `&theme=`. Added `LOGO_DEV_TOKEN` env var support. Added a "Logo source" Segmented control in Settings → Display so the user can compare GitHub vs logo.dev logos live. Preference stored in localStorage, propagated to all TickerLogo instances via custom event. API route accepts `?source=auto|github|logodev` and reorders the cascade. LOGO_DEV_TOKEN added to `.env.local` and documented in `.env.example`. Rollout note: `docs/rollouts/2026-06-21-logo-dev-toggle.md`.
- 2026-06-21: **Accounts connection modal and list formatting simplification.** Simplified Alpaca connection buttons to a single "Connect Alpaca Account" and derived Paper vs Brokerage environment dynamically based on `PA` account number prefix. Enforced required account numbers for Alpaca. Reformatted connected accounts listing with custom titles, green `CONNECTED` and red `AUTONOMOUS` status indicators, and localized test account formatting.
- 2026-06-21: **Alpaca MCP connection & multi-account connection buttons.** Added Alpaca MCP paper/live support, implemented standard JSON-RPC SSE tool call routing with REST client fallback, fixed order type mapping build issues, and ensured all connection buttons remain visible in the dashboard UI for multi-account linking. Verified: tsc clean, 401 tests green, build OK. Rollout note: `docs/rollouts/2026-06-21-alpaca-mcp-integration.md`.
- 2026-06-21 (`agent/claude`): **Multi-agent coordination — verified + gap-filled; landing via PR.** The
  landing protocol that stops the `main` push-races + Q0 worktree collision was already implemented on
  `main` (pre-push hook, `scripts/land.sh`, `core.hooksPath` wiring, AGENTS.md protocol). A 4-agent design
  workflow independently reproduced + validated it and surfaced the honest limits. Added a `land.sh`
  self-heal preflight (auto-sets `core.hooksPath` so a non-bootstrapped worktree still gets the main-push
  guard — closes red-team gap #3), **resolved Q0** (option a), and documented the review +
  residual-limits in `docs/reviews/2026-06-21-multi-agent-coordination-review.md`. Limits that need Jay:
  no server branch protection (private repo → consider GitHub Pro/Team + merge queue); `--no-verify`
  bypass; hooks guard pushes not file-writes; CI inert until `gh auth refresh -s workflow`. **This change
  is landing via `scripts/land.sh` (PR), not a direct push** — dog-fooding the protocol. See
  `docs/rollouts/2026-06-21-coordination-verify-and-gapfill.md`.
- 2026-06-21 (`agent/claude`): **Chat NOW tranche shipped + I4 (real citations).** Executed the approved
  NOW tranche on `main` (`7d766de`→`7a675e8`): I1 stop quote fabrication, I2 server-side disclaimer guard
  + `PROMPT_VERSION 0.4.0`, I3 multi-turn transcript replay, I6 read-only state tools
  (positions/portfolio/watchlist/alerts/proposals — one-way, no execution), I13 router-matched
  suggested-prompt chips (8-K framing). Then on `agent/claude`: **I4** — `retrieveContextDetailed`
  returns REAL provenance (vector id, score, the chunk's own acceptance date, filing url) so citations
  stop fabricating `<SYMBOL>#i` / the query's as_of; the UI renders citation chips as filing links.
  Verified: tsc clean, **412 tests**. Running questions log: `docs/open-questions-for-jay.md` (Q0 =
  worktree collision — a concurrent agent is mid-edit on `main`'s `strategy.ts`/`db.ts`/etc., so this
  lane moved to the isolated `~/apps/trading-claude` worktree and lands via PR). See
  `docs/rollouts/2026-06-21-chat-now-tranche-and-i4.md`.
- 2026-06-21 (`agent/claude`): **Best-of-each branch reconciliation landed on `main`.** A 7-agent
  comparison (`docs/reviews/2026-06-21-branch-reconciliation-best-of-each.md`) resolved the parallel
  agent lanes; the recommended picks were cherry-picked + verified: **tuner missed-opportunity
  counterfactuals** (`6fa51b5`), **SQLite/LLM safety hardening** (`877bb45`, incl. a `\n` prompt bug),
  **AccountCapabilities + two-layer short gate + CI workflow activation** (`d014842`), **logo.dev
  cascade fallback** (`e5dd681`, complementary to main's tile-contrast fix), and **lucide-react 1.21**.
  The antigravity responsive header was already correctly merged to `main` (no regressions — `lg:`
  shell / `min-h-16` / aria-labels / Score-col-2 all intact). **Held:** @types/node 26 (tsc break),
  eslint 10 (peer conflict), zod 4 + next 16 (need migrations). Verified: tsc clean, **404 tests**,
  build green. See `docs/rollouts/2026-06-21-best-of-each-integration.md`.
- 2026-06-21: **Chat/RAG/learning advisory — HYBRID decision + issue log + roadmap.** A 5-agent expert
  panel (RAG, NL-finance-chat, onboarding, prompt/tools, LLM-learning) reviewed the chat assistant and
  unanimously landed on **HYBRID**: ISOLATE write surfaces (execution, strategy weight/risk tuning,
  conversation memory) but SHARE the read substrate (RAG corpus, user constraints, and NEW read-only
  views of positions/P&L/proposals/watchlist/scorecards) — one-way (outcomes flow into chat; chat
  opinions never steer the trading brain except a confirm-gated constraints→policy path). Logged 13
  tracked issues incl. **3 ship-blockers in the shipped chat** (quotes fabricate `change_pct:0`;
  refusal+disclaimer live only in MockLLM so they vanish on the real-LLM path; single-turn —
  `chat_turns` never replayed), the user-guidance design, and a NOW/NEXT/LATER roadmap. User decisions:
  multi-LLM choice (key provisioning deferred), **NOW tranche approved**, constraint→policy via explicit
  confirm + lean integrated learning. Docs only — no code. See `docs/chat-assistant-rag-learning.md` +
  `docs/rollouts/2026-06-21-chat-rag-learning-advisory.md`.
- 2026-06-21: **Responsive header command buttons.** Restructured header buttons to shrink gracefully on narrow screens and wrap cleanly into exactly 2 lines below the `md` (768px) breakpoint.
- 2026-06-21: **UI/UX + iPad/iPhone audit and quick-win implementation.** Ran two
  multi-agent audits (real-Chrome desktop walkthrough → 64-agent review/verify/synthesis; source-grounded
  iPad/iPhone → 27-agent) and shipped the quick wins + high-severity fixes: Market Scan **Score → column 2**
  + horizontal scroll; **zero P&L/tax values now neutral** (`pnlTone`); **light-mode ticker logos fixed**
  (dark tile); **reduced-motion guard** + **iOS 16px inputs**; **macro sparkline polarity** + "Broad USD"
  relabel; Settings tab overflow + no-jump min-height; drilldown header truncation/dedup; a11y (select
  labels, tabpanel ARIA, ≥44px touch targets); chart vertical-touch-scroll; **iPad cockpit shell `xl`→`lg`**;
  and **setup-state run failures render amber** instead of red. Verified: tsc clean, **386 tests**, build
  green; live-confirmed on :4100. Full reports:
  `docs/reviews/2026-06-20-ui-ux-and-mobile-audit.md`; **itemized status-tagged backlog of every
  issue:** `docs/reviews/2026-06-21-ui-ux-issue-register.md`; rollout:
  `docs/rollouts/2026-06-20-ui-ux-audit-and-quick-wins.md`. **Deferred:** F1 backend root cause
  (`src/lib/strategy.ts` `policy.accountNumber` wiring — UI softened only); deleting the **dead
  `app/ui/dashboard/{views,components,utils,settings}.tsx`** parallel implementation; header overflow menu;
  full safe-area/`viewport-fit=cover`. Merged to `main` (2026-06-21).
- 2026-06-21 (`claude/minor-cleanups-data-providers`): **Minor cleanup, zero behavior change.**
  Removed the unused `export const fallbackProvider` alias in `src/lib/data-providers.ts` (confirmed
  referenced nowhere else; `noopProvider` kept — used by tests). Added clarifying one-line comments in
  `src/lib/db.ts` `dailyExecutionStats` / `notionalInLastMinutes` explaining notional caps intentionally
  count only OPENING trades (buy/short); closing trades (sell/cover) are risk-reducing and exempt
  (notional = 0) — comments only, no logic change. tsc clean, 371 tests pass, build OK. See
  `docs/rollouts/2026-06-21-data-providers-cleanup.md`.
- 2026-06-21 (`claude/proposal-timestamps-ui-t7qab1`): **Proposal staleness —
  UI + expiry policy + on-run LLM re-validation.** (Part 1, UI) Pending-approval
  cards show `Proposed <date, time> · <relative age>` with an escalating staleness
  state; removed the redundant "Test Mode" brand-block line + dead
  `executionTone()`; fixed the "too thin"/clipped command bar (`xl:h-14`/`xl:py-0`
  → `min-h-16`). (Part 2, backend) New `src/lib/proposal-revalidation.ts`:
  **deterministic hard expiry** (`policy.proposalExpiryMinutes`, default 2880 =
  2 days; runs at run-start AND every scheduler tick → status `expired`) and a
  **cadence-gated on-run LLM re-check** (`proposalRevalidateCadenceHours`, default
  0 = every run; not optional) that, inside `runStrategyOnce`, asks the LLM whether
  each *due* still-pending proposal still stands — **regular market hours only** (no
  overnight checks). Dropdown: Every run / Once per day / Every 5 days.
  `reaffirm` stamps `last_revalidated_at` (UI: "Re-checked X ago — still
  advised"), `withdraw` → status `withdrawn` + `proposal_withdrawn` notification.
  Safe-by-default: ambiguous LLM output keeps the proposal; market closed / no
  `OPENAI_API_KEY` ⇒ LLM pass skips but deterministic expiry still runs. Both
  surfaced as **dropdowns** + a notification toggle in Settings → Risk. The
  **Flow** button was a question (static React Flow pipeline visualizer,
  `app/ui/strategy-flow.tsx`) — left in place. tsc clean, **314 tests** (+7),
  build green. See
  `docs/rollouts/2026-06-21-proposal-timestamps-and-header-cleanup.md`.
- 2026-06-21 (`chore/safety-quick-wins`): **Failure-mode review + first safety quick-wins.**
  A 12-agent failure-mode brainstorm (114 findings → ~70 distinct) plus a 5-agent
  adversarial verification of the Top 5 (4 confirmed, 1 — "synthetic stops are an
  ungated real-trade cannon" — substantially overstated, crit→low). Full writeup:
  `docs/reviews/2026-06-20-failure-mode-brainstorm.md`. Landed the first quick-win
  batch (no behavior change to the money path): SQLite `busy_timeout=5000` +
  `synchronous=NORMAL` PRAGMAs, bull/bear `JSON.parse` guards (degrade instead of
  crashing the run), `bearSystemPrompt` `\n` join fix, `confidenceScore` clamp +
  schema bounds, and **CI activation** (`ci-pending/*.yml` → `.github/workflows/`).
  tsc clean, 390 tests, build green. NOTE: pushing the CI workflows needs the
  GitHub token re-scoped (`gh auth refresh -h github.com -s workflow`). Deep fixes
  still open: auth layer (T1), execution-section CAS/atomicity (T4/T5), portfolio
  circuit breaker (#7), boot-time autonomy interlock (T3). See
  `docs/rollouts/2026-06-21-safety-quick-wins.md`.
- 2026-06-21: **AccountCapabilities classifier.** Added `AccountCapabilities` interface
  covering equity, shortSelling, options (CBOE level 0–4), futures, crypto, margin, and
  accountType (brokerage/IRA/crypto_exchange). Wired into Robinhood and Alpaca gateways,
  DB persistence (JSON column + migration), policy two-layer short gate, strategy context,
  and coloured capability badges on account cards. Robinhood MCP confirmed: shortSelling
  always false. tsc clean · 390 tests · build OK. See `docs/rollouts/2026-06-21-account-capabilities.md`.
- 2026-06-21: **Alpaca custom base URL & test encryption environment fix.** Added support for custom API base URL for connected Alpaca accounts, and cleaned early-import environment loading inside `src/lib/db.ts` to bypass test environments. Upserted active Alpaca paper trading credentials successfully.
- 2026-06-20: **Alpaca Custom Base URL, DB Encryption Fix & Fintech Studios Integration.** Added custom API endpoint/base URL override in Alpaca account UI, sanitizing trailing `/v2` automatically. Fixed Next.js early-boot race condition by dynamically loading `.env.local` inside `src/lib/db.ts` to ensure stable credentials encryption across server restarts. Integrated Fintech Studios sentiment/news provider in the enrichment cascade. tsc clean, 390 tests, build OK. See `docs/rollouts/2026-06-20-alpaca-custom-base-url-and-db-fix.md`.
- 2026-06-20: **Money-path safety plan (T1–T14) merged to main.** All 14 tasks complete:
  side-aware notional/exposure caps (T1/T10), partial-fill reconciliation (T2), FIFO lot matcher (T3),
  paper-projection guards (T5), db notional tests (T6), short exits (T8), recordFill tests (T9),
  red-team fail-open (T11), tax long-only pin (T12), explicit daily-reset timezone (T13),
  `account_number → __unassigned__` sentinel (T14-db). 386 tests, tsc clean, build clean.
  See rollout `docs/rollouts/2026-06-20-money-path-merge-gate.md`.
- **Completed follow-ups:** gross/net exposure caps added to Settings UI (NumberField + RangeField
  sliders; 0 = no cap); `OpenLot.quantity` now signed (negative for shorts, matches `EquityPosition`).
- 2026-06-20: **AI order-drafting "Assistant" tab (chat → confirm → place).** A 5-agent design panel
  chose a hybrid surface; built per the user's picks (full Assistant tab; live/brokerage allowed with a
  red real-order confirm; inline confirm). New `app/ui/assistant-console.tsx` + an `assistant`
  WorkspaceTab: a chat draft from `/api/chat` is bridged via a new `POST /api/proposals/from-draft`
  (dry-run preview, or insert a `proposed` row — idempotent on `runId='chat:'+draftId`) into the
  UNCHANGED approve → `executeProposal` rail, so the chat module gains **no** execution capability. The
  destination pill derives from the live `executionState`; the mapper (`src/lib/chat/promote-draft.ts`)
  sets the required `TradeProposal` fields and rejects non-buy/sell. tsc clean, 371 tests, build OK,
  verified live (a halted system correctly blocks at the dry-run before any row is minted). See
  `docs/rollouts/2026-06-20-ai-order-drafting-assistant-tab.md`.
- 2026-06-20 (`agent/claude`): **Codex lane reconciled + money-path T5 (paper-projection guards).**
  Codex is usage-capped for days, so Claude took over its lane: a 3-agent parity audit had already
  confirmed Codex's only unmerged commit (tax-treatment + hourly-cap WIP) is fully superseded by
  `main` (R1/R3) with an explicit DO-NOT-MERGE, so there was no unique code to land — reconciled
  `agent/codex` to current `main` (merge favoring main, src now byte-identical), reset its stale local
  `data/app.db` (old `taxation_type NOT NULL` schema), and verified 4101 serving 200. Then advanced the
  money path: fixed **T5** — `getPaperPortfolioProjection` side-blindness (wrong-sign/flat closes +
  opposite-side cost averaging), pinned with 6 tests. tsc clean, 365 tests. `agent/codex`, `agent/claude`,
  `main` pushed. See `docs/rollouts/2026-06-20-money-path-t5-paper-projection.md` +
  `docs/rollouts/2026-06-20-codex-tax-notional-wip-superseded.md`.
- 2026-06-20 (`agent/claude` → `main`): **Landed Claude lane to `main`; last `node:crypto` holdout reconciled.**
  Merged `main` into `agent/claude` to catch up on the 6 Atlas ports + the committed `node:crypto`
  instrumentation fix (`03c6f27`), then merged `agent/claude` → `main` (no-ff) to land the money-path
  tranche-1 fixes below. Fixed the one holdout `03c6f27` missed — `src/lib/memory/store.ts` now imports
  bare `crypto`, not `node:crypto` (mandatory: the `node:` scheme breaks the Next.js instrumentation
  webpack build with `UnhandledSchemeError`). 4100 (PM2 `trading-claude`) verified serving 200; `main` +
  `agent/claude` pushed to origin. See `docs/rollouts/2026-06-20-claude-lane-integration-and-node-crypto-reconcile.md`.
- 2026-06-20 (`agent/claude`): **Money-path safety — tranche 1 (4 bug fixes + 20 tests).**
  From an adversarially-verified audit (38 findings → 12 confirmed → 14-task plan): fixed the
  side-blind per-symbol notional cap that could block automated de-risking exits (T1,
  `policy.ts`), dropped Alpaca partial fills (T2, `strategy.ts` `reconcilePendingFills`,
  idempotent), the side-blind FIFO matcher that erased opposite-side lots at $0 P&L (T3,
  `performance.ts`), and shorts getting no / wrong-side protective exits (T8, `strategy.ts` +
  `synthetic-stops.ts`). Pinned with 20 regression tests (short/cover P&L signs, side-aware
  caps, enabled-path short guardrails, partial-fill booking, synthetic-stop cover exit). tsc
  clean, 327 tests, build green. Remaining: T5/T6/T9–T14 (coverage + cleanup; T10 = gross/net
  exposure-gate design decision). Landed to `main` 2026-06-20 via integration merge (see entry above).
  See `docs/rollouts/2026-06-20-money-path-safety-fixes.md`.
- 2026-06-20: **Atlas public repo retired + 6 subsystems ported to TS.** Reviewed `jaywedgeworth22/public`
  (the "Atlas" BFF) via a 14-agent inventory, preserved it whole (git bundle of all 9 branches + source →
  `reference/atlas-public-src/`), retired its live deployment (uninstalled the `com.jays.trading` BFF + the
  `com.jays.trading.autoupdate` 5-min git-puller + backup cron — reversible bits in `~/.atlas-retired/`),
  and **emptied** the public repo to a tombstone. Ported the genuinely-useful, not-yet-present work to
  TypeScript with tests: RAG structure-aware chunking + `as_of` point-in-time; multi-channel alert delivery
  (push/webhook/email/SMS); conversation transcript + redact-on-write; salience-gated memory; and a chat
  orchestrator (LLM tool-loop, draft-only — never executes) + a 10-case no-execute eval gate. New tables
  `notification_prefs`/`chat_turns`/`user_memory`; new APIs `/api/chat`, `/api/memory`, `/api/notifications`,
  `/api/chat-history`. Deleted the redundant `~/agentic-trading` clone. Verified: tsc clean, 339 tests, build OK.
  **Open:** user to confirm the tunnel still serves the dashboard (then `rm -rf ~/Code/trading`); UI wiring for
  the chat/memory/notify surfaces is deferred (backends only). See `docs/rollouts/2026-06-20-atlas-public-retire-and-port.md`.
- 2026-06-20: **Branch hygiene + Cursor Cloud docs integrated.** Cherry-picked the Cursor
  Cloud setup docs onto `main` (`55213d2`) and pruned branches → the tree is now `main` plus
  the three agent worktree branches. Deleted (tip SHAs in the rollout note for recovery):
  `agent/antigravity-local` (`095175c`, superseded), `codex/phase-7-…` (`b990c14`, merged),
  `codex/upload-current-state` (`47786c4`, merged), and remote
  `cursor/setup-dev-environment-a574` (`7e82278`, integrated). See
  `docs/rollouts/2026-06-20-branch-hygiene-and-a574-integration.md`.
- 2026-06-20: **Cursor positioned as the human review cockpit (not a 4th agent).** Documented
  Cursor's role in `AGENTS.md` (Hosting & dev servers section: integration row now credits Cursor +
  a new "Cursor: the human review cockpit" subsection) and added `.cursor/rules/handoff.mdc`
  (always-applied) so Cursor follows the same read-order + pre-commit handoff protocol as
  Claude/Codex/Antigravity. Cursor occupies the `main` integration seat (`~/Code/Agentic Trading`)
  for review/merge/hand-edits; agent/background runs stay on `cursor/*` branches
  (`origin/cursor/setup-dev-environment-*` already exist). Docs/config only — no code or tests
  changed; landed in `c80a96d` (a concurrent integration commit bundled it with the worktree
  relocation + the `robinhood-agentic-dashboard`→`agentic-trading-dashboard` rename). `main` is
  ahead of `origin/main` pending a push. See
  `docs/rollouts/2026-06-20-cursor-integration-role-and-rules.md`.
- 2026-06-20 (`cursor/setup-dev-environment`): **Cursor Cloud dev environment
  setup.** Installed deps and verified the run/test/build flow in the Cloud VM
  (`npx tsc --noEmit` clean, `npm test` 283 tests, `npm run build` green, `npm
  run dev` on :3000 with a watchlist-config hello-world in Test mode). Added a
  `## Cursor Cloud specific instructions` section to `AGENTS.md` clarifying that
  the host worktree/PM2/port-4100 setup does not apply to the single
  `/workspace` Cloud checkout. No source code changed. See
  `docs/rollouts/2026-06-20-cursor-cloud-env-setup.md`.
- 2026-06-21: **vector-db userId sanitization + timestamp parsing hardening.**
  `getClients()` now sanitizes `userId` before resolving Pinecone/Voyage keys so
  key-lookup identity matches the Pinecone filter identity (multi-tenant
  isolation fix); `[Published: YYYY-MM-DD]` prefixing now handles string/number
  (epoch ms)/Date timestamps; `retryAfterMs` exported for testing. tsc clean;
  `npm test`/`npm run build` NOT run in Cowork sandbox (host node_modules are
  macOS-only) — run locally. See
  `docs/rollouts/2026-06-21-vector-db-userid-timestamp-hardening.md`.
- 2026-06-20 (`agent/antigravity`): **Rename project to Agentic Trading in documents.** Renamed the project title in `PLAN.md` to "Agentic Trading Dashboard", ensuring the overall application is consistently referred to as "Agentic Trading" rather than "Robinhood Agentic Trading" (now broker-neutral to support Alpaca and multi-broker setups). Verifications passed: tsc clean, 287 tests green, build OK.
- 2026-06-20 (integration): **Public-repo consolidation into private dashboard.** Imported Atlas
  (`jaywedgeworth22/public`) design docs to `docs/atlas/`, archived reference material under
  `reference/atlas-public/`, and ported **user watchlist** + **price alerts** (SQLite + API routes +
  scheduler poller + `price_alert` notifications). Chat orchestrator, conversation history, and
  salience memory remain deferred — see `docs/atlas-integration-map.md` and
  `docs/rollouts/2026-06-20-public-repo-consolidation.md`.
- 2026-06-20 (`agent/claude`): **Blueprint R1–R5 completion (in progress).** 6-agent audit of the
  Antigravity/Codex blueprint work, with findings verified against real code (several audit "bugs" were
  false positives reading the blueprint's example snippets; R4 multi-tenant RAG was already shipped by
  `worker_m4_1`). Shipped so far: **R1 tri-state safety banner** (deployed `5747770`); **R3 IRA taxation**
  (IRA ⇒ 0% tax + own-account wash-sale bypass; a TAXABLE-account loss locks rebuys across ALL accounts
  incl. IRAs via `getUserWashSaleLockedSymbols`); **R1 hourly notional cap + auto-revert** to `propose` on
  breach; schema/types foundation (`taxation_type` column, `maxHourlyNotional`, `synthetic_trailing_stops`
  table + accessors, `notionalInLastMinutes`); UI for the hourly cap + a tax-treatment picker. 278 tests,
  build green. **Now also shipped:** the Run/Resume/autonomy controls consolidated into one **Start/Stop**
  + **approval-mode** selector (Propose/Decide) + **Run once**; **R2 synthetic trailing-stop monitor**
  (`synthetic-stops.ts`, +5 tests) with **H4 gated market exits** (scheduler fires them only for
  Started/active users — `systemState==="halted"` ⇒ no orders). **Deferred:** H3 native Alpaca trailing
  (needs a broad `OrderType` change — the synthetic path covers Alpaca for now). 283 tests, build green.
  See `docs/rollouts/2026-06-20-r1-r5-audit-and-safety-banner.md`.
- 2026-06-20 (`agent/claude`): **Broker honesty + account-drives-mode — shipped to `trading.jays.services` (`03bfc38`).**
  Robinhood now connects via its MCP (root cause of the long OAuth failure: the redirect URI must be a
  `http://localhost` loopback, NOT the public Cloudflare-fronted `.services` URL — see memory
  `robinhood-mcp-oauth-prod`). Removed the fabricated `MockRobinhoodGateway` → honest `TestBrokerGateway`
  (real quotes + simulated fills); Robinhood is MCP-only; renamed all `Mock/Local`→`Test`,
  `mock/local`→`test/local`, `Broker Paper`/`Broker Live`→`Paper`/`Brokerage` across src/app/tests
  (the internal `broker/paper`·`broker/live` mode strings stay). The **active connected account drives
  the mode** (Test = local sim / Alpaca Paper / Brokerage); `paperMode` is derived in `getPolicy`; the
  Switch-to-Test/Brokerage toggle is retired; a seeded **Test** account is the always-available safe
  default; Alpaca paper-vs-brokerage derives from the API key prefix (PK/AK); the connect route syncs only
  the Robinhood agentic account. Reconciled with Codex `8654289` (execution-rag) and `e390851` (triggers).
  tsc clean, 261 tests, build green; prod kept on Test, autonomy halted. See
  `docs/rollouts/2026-06-20-broker-honesty-redesign.md`.
- 2026-06-20 (`agent/codex`): **Broker-neutral account connection wording.**
  Updated Accounts UI copy so users are told to connect one or more supported
  accounts when they want broker-backed execution, with Paper accounts optional
  and user-selected. The account modal keeps explicit buttons for Robinhood MCP,
  Alpaca Paper, and Alpaca Brokerage, and Robinhood edit states now describe the
  MCP/OAuth sync path instead of exposing Paper/API-key wording. Docs were
  aligned in README, PLAN, Phase 11, and the architecture blueprint. Verification
  passed: `npx tsc --noEmit`, `npm test` (37 files, 261 tests), `npm run build`,
  `git diff --check`, Playwright smoke against temporary `next start`, PM2
  `trading-codex` restart, `/api/health`, and a focused Accounts modal browser
  smoke on port 4101. See
  `docs/rollouts/2026-06-20-broker-neutral-account-connection-copy.md`.
- 2026-06-20 (worker_m4_1): **Multi-Tenant RAG & Rate-Limit Hardening.** Implemented User ID sanitization, Voyage API rate limit Full Jitter backoff, publication date prepending, parallel Pinecone queries for custom tenants with in-memory deduplication/ranking, Finnhub/FMP transient cache poisoning prevention, Alpha Vantage HTTP 200 warning detection, and raw-user credential lookup preservation. Verification passed: tsc clean, 271 tests green, build OK. See `docs/rollouts/2026-06-20-multi-tenant-rag-rate-limit-hardening.md`.
- 2026-06-20 (`agent/claude`): **Event-trigger Phase 1 (deterministic, no LLM).** Grounded in a
  4-agent investigation of the post-Codex fill/regime/broker surface. (1) **Regime flip detector**
  (`src/lib/regime-watch.ts`) on the scheduler tick — persists `regime:current`, audits + pushes +
  broadcasts a (non-triggering) material event on a flip. (2) **Real-time fills** — Alpaca
  `trade_updates` WebSocket worker (binary frames → JSON, no msgpack) → `onBrokerFill`
  (`src/lib/fills.ts`) reconciles + emits a dashboard `order` event; **fills never trigger an LLM
  run** (expert policy). Opt-in `STREAMS_ALPACA_TRADE_UPDATES_ENABLED`. (3) Closed an SSE gap (run-loop
  placement now emits `order`). Note: true bracket/OCO orders don't exist here — "re-arm brackets" is
  reconcile + a deferred risk re-check. tsc clean, 261 tests, build green; live `trade_updates`
  authorized + regime seeded. See `docs/rollouts/2026-06-20-phase1-deterministic-triggers.md`.
- 2026-06-20 (`agent/codex`): **Terminology documentation alignment.**
  Fast-forwarded the Codex worktree to the integrated `main` tip and aligned
  current-state docs with the runtime Test/Paper/Brokerage terminology. No code
  behavior changed. Verification passed: `npx tsc --noEmit`, `npm test` (37
  files, 261 tests), `npm run build`, `git diff --check`, PM2 `trading-codex`
  restart, and `/api/health` on port 4101. See
  `docs/rollouts/2026-06-20-terminology-doc-alignment.md`.
- 2026-06-20 (`agent/codex`): **Execution/RAG/LLM Blueprint Foundations.**
  Implemented the first runtime slice from `docs/architecture-blueprint.md`:
  `deriveExecutionState(...)` now distinguishes `test/local`, `broker/paper`,
  and `broker/live`; active Alpaca Paper accounts no longer force local
  `paperMode`; strategy, tuning, red-team, and post-mortem LLM context uses the
  same terms; dashboard safety labels show Test, Paper, or Brokerage; OpenAI
  requests share deterministic temperature + output caps; and
  Pinecone RAG guards reserved metadata, queries user-or-public context, and uses
  exponential jittered retry delays. Verification passed: `npx tsc --noEmit`,
  `npm test` (37 files, 261 tests), `npm run build`, `git diff --check`, PM2
  `trading-codex` restart, health/root HTTP checks, and in-app browser Settings
  -> Operate visual smoke. See
  `docs/rollouts/2026-06-20-execution-rag-llm-foundations.md`.
- 2026-06-20 (`agent/antigravity`): **Alpaca Single-Key & OAuth Authentication Support.** Fully enabled Alpaca connection and streaming utilizing only an API Key (OAuth token) without requiring a separate Secret Key. Swapped headers to `Authorization: Bearer <token>` for REST news enrichment fetches when secret key is empty, and updated WebSocket news and trade updates streams to authenticate with `{ action: "auth", key: "oauth", secret: token }`. Adjusted settings modal input placeholders to clarify optional status of the API Secret field. Verification passed: `npx tsc --noEmit`, `npm test` (261 tests), and `npm run build`. See `docs/rollouts/2026-06-20-alpaca-oauth-single-key.md`.
- 2026-06-20 (`agent/antigravity`): **Architecture Blueprint Alignment.** Drafted `docs/architecture-blueprint.md` as a target architecture, not completed runtime implementation, covering:
  1. Section 1.4: Autonomous Live Execution Security Gate & keyframe/animation definitions for animate-pulse-fast.
  2. Section 2.5: Synthetic Stop Edge Case Mitigations.
  3. Sections 3.3 & 3.4: Taxation Policy Settings (IRA Support) - Wash Sale Prevention & DB/Types mapping.
  4. Section 4.4: Multi-Tenant RAG & Rate Limit Hardening.
  5. Sections 5.5 & 5.6: Prompt Caching Surcharge/Eviction & Prompt Abbreviations Glossary.
  The blueprint was corrected after review to avoid implying unfinished controls are already live. Verification passed: TypeScript compiler checks, unit tests, and Next.js production build.
- 2026-06-19 (`agent/antigravity`): **Branch consolidation and plan review.** Committed all uncommitted Codex workspace changes, merged `agent/codex` into `main`, and integrated the updated `main` branch into `agent/claude` and `agent/antigravity` worktrees. Verified the unified tree with type checking, unit tests, and Next.js builds. Reviewed all consolidated plans, UX expert guidance, and cross-functional expert guidelines. Devised a review report and architectural flow. See `docs/rollouts/2026-06-19-branch-consolidation-and-review.md`.
- 2026-06-19 (`agent/codex`): **Expert guidance consolidation.** Consolidated
  scattered UI/design/financial-products UX advice into
  `docs/reviews/ui-expert-guidance.md`, and non-UI strategy/architecture/LLM/risk/data
  expert-panel advice into `docs/reviews/cross-functional-expert-guidance.md`.
  Original dated reviews and rollout notes remain as evidence; the new docs are
  the entry points for future work. See
  `docs/rollouts/2026-06-19-expert-guidance-consolidation.md`.
- 2026-06-19 (`agent/codex`): **Ticker logo display preference.** Added a
  cached `/api/logos/ticker` proxy for `davidepalazzo/ticker-logos` PNGs and a
  local Settings → Display preference for Normal tile, Transparent, or Off.
  Portfolio symbols, Market Scan rows, and Symbol Intelligence headers now use
  the selected display mode while falling back to text when a logo is missing.
  Verification passed: raw GitHub PNG HEAD probe, focused logo tests, `npx tsc
  --noEmit`, `npm test` (248 tests), `npm run build`, `git diff --check`, PM2
  preview restart, local `/api/health`, `/api/logos/ticker?symbol=AAPL`, root
  `localhost:4101/`, and Playwright Settings → Display + mobile overflow smoke.
  See `docs/rollouts/2026-06-19-ticker-logo-display.md`.
- 2026-06-19 (`agent/codex`): **Operate universe UI and backend index support.**
  Settings → Operate now groups Base indexes, Additional Watchlist, and Ignore
  List together; S&P 500 is the default starting universe, and base indexes are
  large multi-select toggle buttons for S&P 500, Nasdaq 100, and Dow 30. A
  one-time backend migration moves untouched empty default policies to S&P 500
  without reapplying after a user intentionally clears the universe. Backend
  policy expansion, policy API validation, scanner counts, and LLM tuning
  context now use the same shared index-universe source, with the Ignore List
  subtracting from both indexes and additional symbols. Smart Money tickers fall
  back to sparse symbol-drawer records instead of inert bold text when the latest
  scan lacks that symbol. Verification passed: focused default-universe
  migration test, `npx tsc --noEmit`, `npm test` (250 tests), `npm run build`,
  `git diff --check`, PM2 preview restart, `/api/health`, `/api/policy`,
  `HEAD /`, and identity-encoded `GET /` returning 200 on port 4101. Browser
  visual verification was attempted through the in-app browser but blocked by
  Browser Use URL policy. See
  `docs/rollouts/2026-06-19-operate-universe-watchlist-ignore.md`.
- 2026-06-19 (`agent/codex`): **Worktree cleanup.** Normalized the partial
  staged/unstaged index left after the Claude pickup and Codex patch reapply,
  kept the documented UI audit, pending-demand, and Market Scan VWAP changes,
  and verified the combined state with `npx tsc --noEmit`, `npm test` (242
  tests), `npm run build`, `git diff --check`, PM2 preview restart, and
  `/api/health` + `/api/scan` returning 200 on port 4101. See
  `docs/rollouts/2026-06-19-codex-worktree-cleanup.md`.
- 2026-06-19 (`agent/codex`): **Shared market-data pending demand.** Added
  durable `market_data_demands` for failed public OHLC reads, source-scoped
  history cache writes, and a `market-data` SSE event so a later shared cache
  fill refreshes prior requesters without spending another user's private key.
  User-key provider fills remain private by default unless
  `MARKET_DATA_SHARE_USER_KEYED_HISTORY=on`; the pending TTL is controlled by
  `MARKET_DATA_PENDING_TTL_MS`. Full verification passed: `npx tsc --noEmit`,
  `npm test` (242 tests), `npm run build`, `git diff --check`, PM2 preview
  restart, and `/api/health` on port 4101. See
  `docs/rollouts/2026-06-19-market-data-pending-demand.md`.
- 2026-06-19 (`agent/codex`): **Claude pickup + scan-row VWAP follow-up.**
  Fast-forwarded the Codex worktree to Claude's streaming/event-trigger tip,
  preserved the existing Codex UI audit patch, and continued Claude's explicit
  VWAP follow-up by surfacing `price vs VWAP` in Market Scan rows. `/api/scan`
  now opportunistically merges cached Massive grouped daily `vw` data into
  `MarketQuote.vwap`/`MarketQuoteSummary.vwap` with source attribution
  (`massive-vwap`); the table shows a sortable `vs VWAP` column and degrades to
  `-` when no Massive key/data is available. Verification passed: `npx tsc
  --noEmit`, `npm test` (240 tests), `npm run build`, `git diff --check`, and
  Codex preview `/api/health` + `/api/scan` returned 200. See
  `docs/rollouts/2026-06-19-claude-pickup-vwap-scan.md`.
- 2026-06-19 (`agent/claude`): **Streaming + event-trigger pass.** (1) **VWAP surfaced** —
  dashed overlay + "% vs VWAP" on the price chart. (2) **order/proposal SSE emits**
  (`executeProposal`/`rejectProposal`/cancel route). (3) **Alpaca news WebSocket worker** —
  first outbound stream (`src/lib/streams/`), opt-in `STREAMS_ALPACA_NEWS_ENABLED`, push-feeds a
  news store the enrichment provider reads first (REST fallback); live-verified `authenticated +
  subscribed`. (4) **Event-driven LLM trigger engine** (`src/lib/triggers.ts`, Phase 0/2, DEFAULT
  OFF) — mode switch, debounce/coalesce, `admitRun` gate (cooldowns + hourly/daily caps), dedup,
  8-K material-item producer; policy from a 4-expert panel (see
  `docs/event-driven-llm-triggering.md`). tsc clean, 239 tests, build green. See
  `docs/rollouts/2026-06-19-vwap-emits-ws-worker-trigger-engine.md`.
- 2026-06-19 (`agent/claude`): **Push-vs-poll + compute-offload pass.** Added
  `docs/data-architecture-push-vs-poll.md` (durable principles + opportunity inventory +
  scoping). Shipped: (1) **VWAP capture** — we were dropping Massive's `vw`; now in
  `GroupedDailyBar`/`OHLCBar.vwap`. (2) **Sentiment offload** — cascade prefers Alpha Vantage's
  real `NEWS_SENTIMENT` over the `scoreHeadlines` keyword proxy. (3) **SSE dashboard push** —
  new in-process event bus (`src/lib/events.ts`, globalThis-pinned), `app/api/events/stream`
  endpoint, `run-complete` emit in `runStrategyOnce`, client `EventSource`; 30s blind poll
  demoted to 120s fallback. Live-verified push delivery (`subscribers:1`, `event: dirty`
  received). tsc clean, 233 tests, build green. See
  `docs/rollouts/2026-06-19-push-vs-poll-vwap-sentiment-sse.md`.
- 2026-06-19: **UI expert audit and safety/readability polish**. A parallel
  UI/design, accessibility/responsive, and financial-products UX review plus
  live browser probing found first-run state ambiguity, mobile fixed-shell
  clipping, blank Market Scan empty states, raw activity JSON, and overstated
  symbol-drawer signal language. The active dashboard now shows `Setup Needed`
  instead of `Autonomy On` when account/universe prerequisites are missing,
  blocks Run/Resume through setup routing, exposes persistent Test/Paper/Brokerage mode,
  confirms live-mode switching, restores mobile page scrolling with a compact
  portfolio summary, replaces blank scan grids with actionable empty states,
  summarizes activity payloads, raises helper-text contrast, starts new defaults
  halted/propose, and sends LLMs `test/local` execution-mode context instead of
  ambiguous Paper-mode language. Dashboard charts now use SSR-safe SVG/CSS
  primitives plus a hydration shell so the Codex `next dev` preview serves `/`
  cleanly after build regeneration. See
  `docs/rollouts/2026-06-19-ui-expert-audit-polish.md`.
- 2026-06-19: **Integration worktree scratch cleanup**. Added root-only ignore
  rules for manual screenshot captures, one-off UI probe scripts, and accidental
  SQL-named shell output files so the `main` integration checkout stays usable
  for review/fast-forward merges. Existing untracked scratch files in
  `~/Code/Agentic Trading` were classified as disposable local
  artifacts. See `docs/rollouts/2026-06-19-integration-scratch-cleanup.md`.
- 2026-06-19 (`agent/claude`, committed): **Pinecone RAG fixed + backfilled (0→83
  vectors) and Robinhood MCP market data wired.** Root cause of the empty index was a
  swallowed Voyage 429 (billing) stacked on a latent **Pinecone v8 upsert bug** —
  `index.upsert(records)` must be `index.upsert({ records })` for
  `@pinecone-database/pinecone@8` (never fired before because Voyage 429'd first).
  `storeContexts` now audits its outcome; added `reindexEightKDataset` +
  `getVectorStoreStats` + dev-gated `POST /api/admin/reindex-8k`. Robinhood
  `get_equity_historicals` → OHLC cascade and `get_equity_fundamentals` → enrichment,
  inert until `ROBINHOOD_ADAPTER=mcp` + OAuth (adapter currently `mock`); verify shapes
  via `GET /api/admin/robinhood-probe`. **Also added: Alpaca free Benzinga news**
  (`AlpacaNewsEnrichmentProvider`, live in `MarketScan.source`) and **closed the HOUSE-congress
  gap** via an Apify `johnvc` actor adapter in `web-sources/congress.ts` (forced refresh =
  125 House + 61 Senate; House was 0). Verified: tsc clean, 233 tests (post-merge), build green, live
  backfill + congress refresh confirmed. See `docs/rollouts/2026-06-19-pinecone-fix-and-robinhood-data-wiring.md`.
- 2026-06-19: **Market-data sharing/isolation guardrails**. Made the first
  broker/keyed market-data sharing decision explicit in code and docs: env-key/free
  OHLC history remains globally cached, saved user-key OHLC history is private by
  default, and `MARKET_DATA_SHARE_USER_KEYED_HISTORY=on` is required before user-keyed
  non-personal bars can enter the shared cache. Fixed broker quote source attribution
  so `mergeQuoteData` reports actual providers such as `alpaca-quotes` instead of
  always appending `robinhood-quotes`. Full verification passed:
  `npx tsc --noEmit`, `npm test` (231 tests), and a clean `npm run build`; the
  warmed Codex PM2 preview returned 200 for `/` and `/api/health`. See
  `docs/rollouts/2026-06-19-market-data-sharing-guardrails.md`.
- 2026-06-19: **Data-source failure hardening** for Capitol Trades, Voyage/Pinecone
  vector memory, and Massive S3 flat files. Capitol Trades' public BFF currently
  returns HTTP 503 HTML from this environment and the interactive site returns HTTP
  429 to local non-browser fetches; Senate eFD still works, and the secondary
  Capitol Trades adapter can now be disabled with `WEB_SOURCE_CAPITOLTRADES_URL=off`.
  SEC 8-K vector ingestion is capped and paced (`WEB_SOURCE_SEC8K_RAG_LIMIT`,
  `VECTOR_EMBED_*`) with 429 retry handling; after billing was added, a live
  `voyage-finance-2` probe succeeded with a 1024-dimension embedding, so the caps are
  now cost controls rather than emergency rate-limit workarounds. Massive S3 now
  prefers the dedicated S3 secret before the REST key, but live probes still return
  403 `NOT_AUTHORIZED`; Massive REST grouped bars remain healthy (12,299 rows for
  2026-06-18) and now share a `MASSIVE_REST_MAX_CALLS_PER_MINUTE=5` local budget for
  Basic/free-plan safety. Full
  verification passed: `npx tsc --noEmit`, `npm test` (226 tests), and
  `npm run build`. See
  `docs/rollouts/2026-06-19-data-source-failure-hardening.md`.
- 2026-06-19: **UI UX Polish and Consistency Fixes**. Addressed bugs causing a blank market scan due to unhandled undefined Universe arrays. Improved UX by ensuring all Congressional/Insider symbols are clickable via `SymbolButton` utilizing synthetic quotes. Improved styling consistency of numeric parameters and simplified redundant top header metrics. Lightened the global dark mode theme and Command Palette backdrop for better readability. Fixed `onBlur` race conditions in Settings inputs and added a new UI to manage the symbol `blocklist`.
- 2026-06-19: **UI Polish & Policy Schema Refactoring**. Addressed the user's request to consolidate duplicate Strategy settings out of the Settings Modal and into the Strategy Tab. Implemented the composite Universe schema (`includedIndices` + `additionalSymbols`) and updated the "Universe" selection UX with an `EditableParam` $ / % toggle. Fixed resulting TypeScript errors in `dashboard-client.tsx`, `settings.tsx`, and `views.tsx`. `npm run build` is passing successfully.
- 2026-06-19: **Ops/observability/security foundation selected by user**. Added
  Infisical command wrappers, Gitleaks local + CI scans, Sentry Next.js runtime
  hooks, Langfuse LLM tracing with redacted summary capture by default, Dependabot
  config, Litestream SQLite backup/restore wrappers, and Playwright dashboard smoke
  tests. These are opt-in unless their env vars/host CLIs are configured. See
  `docs/ops-observability-security.md` and
  `docs/rollouts/2026-06-19-ops-observability-security.md`.
- 2026-06-19: **Broker Connection UI Split**. Split the unified "Add Account" UI in the dashboard into distinct buttons for each broker (Alpaca vs Robinhood) and customized the editing form to only require API Keys/Secrets for Alpaca. This prevents user confusion since Robinhood uses an OAuth flow via the MCP server and Alpaca requires static keys. Full verification passed.
- 2026-06-19: **Composite Universe & System State Migration**. Replaced `universe`, `allowlist`, `enabled`, and `killSwitch` in `TradingPolicy` with a robust composite universe (`includedIndices`, `additionalSymbols`, `blocklist`) and a unified `systemState` (`active`, `halted`, `liquidating`, `close_only`). The policy engine, strategy runner, scheduler, tuning, and UI components were completely migrated. A new NAV-based sizing rule (`maxOrderPctOfNav`) was also introduced in the `DEFAULT_POLICY`. Full verification passed: `npx tsc --noEmit`, `npm test` (223 tests), and `npm run build`.
- 2026-06-19: **Price chart timeframe controls and history expansion**. Added
  standard Yahoo Finance-style timeframe buttons (1D, 5D, 1M, 6M, YTD, 1Y, 5Y, All) 
  to the Symbol Drilldown price chart. Expanded the backend `fetchDailyOHLC`
  history fetch horizon from ~1.1 years to 5 years (1825 days) to support the
  longer timeframes. See `docs/rollouts/2026-06-19-price-chart-timeframes.md`.
- 2026-06-19: **Live-safety/risk-controls slice (Phase 10 E4/E5)**. Red Team
  review threshold is now a policy tuning knob (`redTeamConvictionThreshold`,
  default behavior 80), and `crisisMaxOpeningExposurePct` optionally caps new
  buy/short notional as a % of portfolio value when deterministic
  `entryMarketRegime` is crisis or inverted-curve. The cap is off when unset or
  <=0, and it does not block risk-reducing sells/covers. Focused tests cover the
  default/custom threshold and crisis-cap open-vs-exit behavior. Full verification
  passed: `npx tsc --noEmit`, `npm test` (223 tests), and `npm run build`.
- 2026-06-19: **Durable skipped-candidate counterfactuals (Phase 10 B3)**.
  Skipped `signal_snapshot` evidence now materializes into
  `skipped_candidate_counterfactuals` with user-scoped watermarks, target dates,
  OHLC-derived exit prices, returns, dominant factors, sectors/regimes, and
  bulletins. Strategy runs trigger a bounded background refresh after writing the
  signal snapshot; matured rows feed `skippedCounterfactuals` before the
  current-scan fallback. Focused tests cover idempotency and user isolation. Full
  verification passed: `npx tsc --noEmit`, `npm test` (223 tests), and
  `npm run build`.
- 2026-06-19: **Clickable tickers everywhere + symbol drawer reorder** (UI).
  Every standalone ticker (Decision proposals, Portfolio rail, Tax tables +
  red wash-sale lockout chips, Smart Money congress/insider) now opens the
  Symbol Intelligence drilldown — not just Market Scan rows. New `SymbolButton`
  (faint underline at rest, link-blue on hover; `chip` variant keeps red/box and
  goes bold-italic). Clicks resolve symbols against a live `/api/scan`
  (`tickerScan`) because `latestStrategyRun.marketScan` isn't rehydrated after a
  restart. Drawer reorder: Evidence Bulletins moved up, Source Provenance now
  full-width at the bottom. Feature code already landed in `8d5de0f`; verified
  `tsc` + `npm test` (210) + `npm run build`. See
  `docs/rollouts/2026-06-19-clickable-tickers-and-drawer-reorder.md`.
- 2026-06-19: Production-ops hardening attempted to add GitHub Actions CI for
  the required verification sequence, but GitHub rejected the push because the
  current OAuth credentials lack `workflow` scope. The workflow file is deferred
  until credentials are updated; local required verification still passed. See
  `docs/rollouts/2026-06-19-ci-verification.md`.
- 2026-06-19: Broker/provider boundary cleanup tightened Alpaca, Robinhood, and
  enrichment-provider parsing with safer optional numeric/string handling, so
  missing upstream fields remain absent instead of leaking `NaN`, empty strings,
  or `"undefined"` into downstream data. `.air/` editor settings are now ignored.
  Full verification passed: `npx tsc --noEmit`, `npm test` (223 tests), and
  `npm run build`. See
  `docs/rollouts/2026-06-19-broker-provider-type-cleanup.md`.
- 2026-06-18: Active dev is on branch **`phase-10`**, executing
  `docs/phase-10-signals-learning-ui-v2.md` (status markers in that doc are the
  source of truth for what's next). `phase-10`, `main`, and `origin/main` are
  aligned at `9bcf133`; the old standalone "merge web-sources → main" item is
  superseded. Shipped Phase 10 work now includes positioning re-score/re-sort,
  sector scorecard, full chosen+skipped EvidenceDigest, SEC 8-K item-enriched bulletins,
  market breadth/internals, expanded FRED/macro metrics, Fama-French, Cboe
  SKEW/VVIX, CFTC COT, technical signals, batched Voyage/Pinecone RAG scaffold,
  and symbol drilldown. Next highest leverage: D1/D2 prompt efficiency, B3/B4
  skipped-name/factor learning, E1/E2 completion, C5/C6 analyst/XBRL sources,
  and API-key routing from `docs/phase-11-multi-user.md`. Share-quantity policy is finalized: records keep
  full double precision; display = 3 sig figs OR all whole-number digits,
  whichever is larger, comma-grouped (`formatQuantity`; see
  `docs/rollouts/2026-06-17-quantity-precision-display.md`). Git commits use the
  CLT workaround (`DEVELOPER_DIR=/Library/Developer/CommandLineTools`) until the
  Xcode license is accepted. iCloud sync-conflict files (`"<name> 2.<ext>"`) are
  gitignored.
- Current publish branch packages the latest dashboard, cockpit UI,
  market-data, strategy, short/cover, and handoff-doc work for review.
- 2026-06-19: Robinhood MCP connection hardening landed as the first backlog
  slice from the external-app review. `src/lib/robinhood.ts` now defaults to the
  official Trading MCP endpoint, sends Streamable HTTP/SSE + protocol headers,
  parses JSON and SSE responses, unwraps Robinhood's `data` envelope, and exposes
  a `GET /api/broker/mcp/health` diagnostic route that checks auth and lists
  available tools. While verifying, narrow Phase 11 user-key plumbing was also
  aligned so API-key validation, Red Team, and post-mortem OpenAI calls remain
  buildable through `resolveApiKey`. UI status-card wiring is deferred to avoid
  colliding with concurrent account/settings changes in `app/dashboard-client.tsx`.
  Verified with `npx tsc --noEmit`, `npm test` (200 tests), and `npm run build`. See
  `docs/rollouts/2026-06-19-robinhood-mcp-transport.md`.
- 2026-06-19: Phase 10/11 continuation added Settings → API Keys with source-aware
  Set / Using env / Not set status, write-only masked save/clear controls, provider
  docs links, and a broadened `/api/keys` catalog. Major keyed paths now route
  through `resolveApiKey(service,userId)`: OpenAI strategy/tuning/red-team/
  post-mortem, enrichment providers, FRED macro/history, keyed OHLC, Massive
  breadth/news/flat-file helpers, SEC EDGAR UA, and Pinecone/Voyage. Strategy-run
  audit/daily-stat/fill/snapshot paths got narrower default-user scoping, and the
  Bull/Bear scan payload drops neutral empty fields. Verified with `npx tsc
  --noEmit`, `npm test` (201 tests), and `npm run build`. See
  `docs/rollouts/2026-06-19-api-key-routing-and-prompt-compaction.md`.
- 2026-06-19: Accounts modal now surfaces Robinhood MCP connection state from
  `GET /api/broker/mcp/health`, including adapter mode, endpoint/protocol,
  available tool names, refresh, and OAuth-connect action. Remaining mutable API
  routes touched by Accounts/API-key/order/policy flows are now explicitly
  dynamic so `next build` does not try to collect static page data for them. See
  `docs/rollouts/2026-06-19-robinhood-mcp-status-card.md`.
- 2026-06-19: Phase 10/11 backend continuation added per-user strategy run locks,
  broader active-user discovery, user-scoped paper projections, scorecards,
  signal-efficacy joins, tax/wash-sale reads, notification audits, dashboard
  proposal/scheduler callbacks, and post-mortem reflection storage. Phase 10 now
  feeds `factorOutcomes` and high-return `skippedCounterfactuals` into the Bull
  prompt from existing `signal_snapshot` evidence, and the unsafe stateless
  portfolio/positions prompt omission was removed. Full combined-tree verification
  passed: `npx tsc --noEmit`, `npm test` (210 tests), and `npm run build`. See
  `docs/rollouts/2026-06-19-phase-10-11-learning-isolation.md`.
- 2026-06-19: Phase 11 request-level user resolution scaffolding added
  `resolveRequestUserId(request, body?)`, reading `x-user-id`, then `userId`
  query/body hints, then falling back to `local`. High-impact API routes now pass
  the resolved user into existing user-aware policy, strategy, proposal,
  account, key, order, dashboard/scan, history/flat-file, audit, and profile
  paths. This preserves current no-auth dashboard behavior and does **not** mark
  authentication complete. See
  `docs/rollouts/2026-06-19-request-user-resolution.md`.
- 2026-06-19: Added an opt-in, read-only `webull-unofficial` enrichment provider
  that shells out to `scripts/webull_unofficial_quote.py` only when
  `WEBULL_UNOFFICIAL_ENABLED` is explicitly enabled. It can source quote fields
  (`price`, bid/ask, intraday move, volume, 52-week range, name) with attribution,
  but does not log in, place orders, or produce learning-grade fills. The runtime
  subprocess path avoids static `child_process` imports so Next dev/instrumentation
  still compiles. See
  `docs/rollouts/2026-06-19-webull-unofficial-market-data.md`.
- 2026-06-19: Added a Codex-owned dev launcher, `npm run dev:codex`, that pins
  Next dev to `127.0.0.1:3001` and frees only that port before starting. This
  keeps Codex browser checks isolated from Claude/local port-3000 sessions. See
  `docs/rollouts/2026-06-19-codex-dev-port.md`.
- 2026-06-18: Fully utilized Massive (REST history primary in the OHLC cascade,
  full-market breadth, market news on the Macro tab, a bulk daily-bars route
  `GET /api/market/flatfile`, and a SigV4 S3 flat-file connector — signature
  verified, object download plan-gated). Split account management into a dedicated
  **Accounts** modal (out of Settings). Fixed a cold-start cache-poisoning bug so
  macro/breadth/history caches only store successful, non-empty results (breadth
  has its own 30-min success cache). Ran a two-track multi-agent platform review
  (UX + architecture/strategy/LLM) → `docs/reviews/2026-06-18-*.md` (verify/synth
  truncated by a session limit; reports reconstructed from the reviewers' findings).
  See `docs/rollouts/2026-06-18-massive-full-util-accounts-modal-review.md`.
- 2026-06-19: **Per-agent live-preview worktrees.** Each AI agent now works in its own
  git worktree on its own branch with its own PM2-hosted live `next dev` (HMR) on its own
  port — fully isolated `node_modules`/`.next`/`data`/`.env.local`, so one agent's edits or
  `npm run build` never touch another's preview or production: Claude →
  `~/apps/trading-claude` (`agent/claude`) :4100; Codex → `~/apps/trading-codex`
  (`agent/codex`) :4101; Antigravity → `~/apps/trading-antigravity` (`agent/antigravity`)
  :4102. `~/Code/Agentic Trading` (`main`) is the integration/merge worktree
  (no agent dev server). Production unchanged: pm2 `trading`, `next start` :4000. Bootstrap/
  repair with `scripts/setup-agent-previews.sh`; see the rewritten "Hosting & dev servers"
  section in `AGENTS.md`. Key rule: a running port is NOT a work lock — coordinate via git +
  STATUS.md only. (Supersedes the earlier single committed `trading-preview` :4100 idea.)
- **Data Optimization**: Market Scan ranks the broad universe down to the configured candidate cap, then can reserve below-cutoff outliers with notable congress, insider, short-pressure, or technical signals. The JSON payload is heavily minified (`symbol` -> `sym`, `marketCap` -> `mktCap`) to save LLM context window tokens.
- **Regime Detection**: The current market regime is deterministically evaluated using VIX and Fed rates, shifting the responsibility entirely from the LLM.
- **UI UX Polish**: The cockpit features interactive charting (Recharts Brush for panning/zooming), Sonner toasts for real-time action feedback, and dynamic lazy-loading for heavy bundle dependencies.

## Blockers / Open Questions
None. Phase 2 backend optimization is complete.
- 2026-06-16: completed a cockpit-UI optimization pass (presentation-only) —
  fixed the floating-alert positioning bug (now a bottom-right toast stack),
  added modal/tab accessibility (Escape, focus management, scroll-lock, ARIA),
  extracted ~400 lines of inline styles into CSS classes, and removed dead
  TS/CSS. Verified with `tsc` + `npm test` (80) + `npm run build`. See
  `docs/rollouts/2026-06-16-ui-optimization-pass.md`.
- 2026-06-16: LLM token + learning-loop pass — added an outcome-aware Thesis
  Scorecard (realized win/return/P&L per `tradeThesisTag`) fed to the Bull agent
  and reflection; gated the post-mortem so it only regenerates on new trades
  (saves a call + enables prompt caching); trimmed redundant prompt context
  (allowlist cap, slim recent orders, leaner Bear critique). Then deepened it:
  MAE/MFE excursion timing stats (`getExcursionsByThesis`), regime-conditioned
  outcomes (`getRegimeScorecard`), and delta-only macro pruning (`pruneMacro`).
  Adversarially reviewed (P&L/integration clean; one prompt-wording nit fixed).
  Verified with `tsc` + `npm test` (86) + `npm run build`. See
  `docs/rollouts/2026-06-16-llm-token-and-learning.md`.
- 2026-06-16: bottom drawer (Activity/Runs/Notifications) now has a per-tab
  minimum height (~2 entries) and a discoverable resize grip; content scrolls.
  See the resizable-bottom-drawer section in
  `docs/rollouts/2026-06-16-ui-optimization-pass.md`.
- 2026-06-16 (branch `ui-redesign`): full presentation redesign into a themable
  dark/light "trading terminal" — Tailwind 4 + Recharts + Motion, command bar,
  Portfolio rail + tabbed workspace (Decision/Market/Performance/Strategy),
  feeds as a right slide-over, modal Settings/Strategy Studio, ⌘K palette, and a
  Recharts learning-loop visualization (P&L by thesis/regime). Data/agent layer
  unchanged (snapshot now also carries thesis/regime scorecards). `tsc` + 86
  tests + build pass. See `docs/rollouts/2026-06-16-ui-redesign-tailwind.md`.
  Analyzed `RobinAgent-MCP`: a thin AI-Studio mockup — borrowed UI polish only;
  our agent engine is far ahead.
- 2026-06-16 (branch `ui-redesign`): US tax-mitigation features — wash-sale
  lockout guardrail (policy blocks rebuying a symbol sold at a loss within 30
  days), a Tax tab (ST/LT realized, estimated liability, wash-sale flags,
  tax-loss-harvest candidates, days-to-long-term), after-tax agent context, and
  Tax settings. New `src/lib/tax.ts`. `tsc` + 92 tests + build pass. See
  `docs/rollouts/2026-06-16-tax-mitigation.md`. Estimates only — not tax advice.
- 2026-06-16 (branch `ui-redesign`): signals + learning-loop pass (tractable
  subset of Codex's "Stronger Trading Signals And Learning Loop" research plan).
  Plumbed five already-fetched-but-orphaned fields (`fcfYield`, `debtToEquity`,
  `epsGrowth`, `insiderSentiment`, `senateTrades`) end-to-end into factor scoring
  (`valueScore`/`qualityScore`), the agent prompt, and the Market Scan table
  (FCF% / D/E / EPS gr columns). Constrained `tradeThesisTag` to a fixed 10-tag
  `THESIS_PLAYBOOK` enum on both Bull + Bear schemas. Added Bayesian shrinkage
  (`shrunkWinRate`/`shrunkAvgReturnPct`, 5-trade neutral prior) to the
  thesis/regime scorecards. Added a `candidates_considered` audit logging chosen
  vs top-skipped scan candidates per run for future counterfactual learning.
  `tsc` + 93 tests + build pass. See `docs/rollouts/2026-06-16-signals-learning.md`.
  Deferred to next phase: new providers (Alpha Vantage/FMP/SEC/FINRA/Cboe/FRED/
  Kenneth French), SignalSnapshot/EvidenceDigest layer, thesis×regime×sector×factor
  learning with a 20-lot gate, async digests.
- 2026-06-16 (branch `web-sources`, off merged `main`): backend **web-sources**
  subsystem + finished Codex learning-loop remainder. (a) Fixed a real bug — the
  scan enrichment merge dropped `fcfYield`/`debtToEquity`/`epsGrowth`/`senateTrades`,
  so the Phase-6 plumbing was dead; extracted `applyEnrichment` + fixed the summary
  projection. (b) New `src/lib/web-sources/`: a Senate eFD + Capitol Trades
  **congressional-trades** connector and a **SEC EDGAR Form 4** insider connector
  (open-market P/S only), polite cached fetch, persistent daily-refreshed datasets,
  scheduler hook, scan overlay (cache-only, no network in hot path), Congress scan
  column, `smartMoneyEvidence` prompt bulletins with front-running guidance. Never
  fabricates — sources down → no signal. (c) `signal_snapshot` audit per run;
  `getThesisRegimeScorecard` (thesis×regime) fed to the agent; **min-20-closed-lot
  gate** on auto-tuner factor-weight shifts. `tsc` + 113 tests + build pass; live
  scrapes verified (78 real congress trades; SEC parser on live filings). See
  `docs/rollouts/2026-06-16-web-sources-and-learning.md` and
  `docs/phase-9-web-sources.md`. This branch status is historical; the work is now
  included in the `phase-10`/`main` lineage.
- 2026-06-17: Phase 10 (E1) - Symbol Drilldown Drawer. Added a clickable row action to `MarketScanView` that slides out a `SymbolDrilldown` drawer. It now labels normalized 0-100 values as factor scores, not a true weighted waterfall. See `docs/rollouts/2026-06-17-symbol-drilldown-drawer.md`.
- 2026-06-17: Alpaca Broker Integration. Added `@alpacahq/alpaca-trade-api` and native `AlpacaBrokerGateway` (`src/lib/alpaca.ts`). Scaffolded `user_api_keys` and getters/setters in `src/lib/db.ts` for multi-tenant keys. See `docs/rollouts/2026-06-17-alpaca-integration.md`. Next up: Broker selection in UI and integrating into strategy runs.
- 2026-06-18: Multi-Account Architecture. Replaced the single-account toggle with a robust multi-account switcher in the UI. Added an `Integrations` tab to `SettingsModal` for adding/removing Robinhood and Alpaca accounts with their API keys. Modified `src/lib/db.ts` so `getPolicy` dynamically inherits `paperMode`, `accountNumber` and `activeBroker` from the active connected account, meaning execution and tracking are isolated to the active account without needing to refactor `runStrategyOnce`. See `docs/rollouts/2026-06-18-multi-account-architecture.md`.
- 2026-06-18: **Technical-signal web source (Phase 10 A2.1)** — the first bar-based
  technical pipeline (RSI/MACD/MA crossovers), filling the stack's one signal gap. One
  per-symbol dataset, two interchangeable producers via `TECHNICAL_SOURCE`: **TradingView**
  push (Pine `alert()` → secret-gated `POST /api/webhooks/tradingview`) for the trial
  window, and **in-house computed** (free Yahoo/Stooq OHLC → `computeTechnicals`) as the
  durable free fallback. Overlays the scan, blends the `momentum` factor, joins the event
  union, emits bulletins, captured in the evidence digest. New `src/lib/indicators.ts`,
  `src/lib/web-sources/technical.ts`, the route, + 18 tests. `tsc` + **178 tests** + build
  green; webhook live smoke-tested (fixed a `node:crypto` dev-webpack break → `crypto`).
  Lighter `momentum`-blend used instead of a new ScoringWeights factor to avoid colliding
  with concurrent scoring edits. Operator guide: `docs/tradingview-pine-setup.md`. See
  `docs/rollouts/2026-06-18-technical-signals-tradingview.md`. Not yet committed.
- 2026-06-18: **Price chart in the symbol drilldown** — TradingView **Lightweight Charts v5**
  (MIT, lazy-loaded) showing 1Y candlesticks + SMA50/200 + volume, themed via CSS vars, fed
  our own OHLC via new `GET /api/history`. Generalized the OHLC fetch into `src/lib/history.ts`
  with a **keyed-first cascade Tradier → Marketstack → Yahoo → Stooq** (free endpoints are
  blocked server-side: Yahoo 429, Stooq bot-challenge; Tradier/Marketstack keys work, 276
  bars). Technical `computed` producer refactored to reuse it. New `price-chart.tsx`,
  `history.ts`, route, +7 tests (188 total). Browser-verified (NVDA drilldown renders).
  **Open blocker (concurrent edit, not this work):** `src/lib/dashboard.ts:107` fails `tsc`
  — `computeMarketInternals` is fed a trimmed `latestStrategyRun.marketScan`; owner of the
  macro-internals work to resolve. See `docs/rollouts/2026-06-18-price-chart-lightweight-charts.md`.
- 2026-06-18: **Voyage AI & Pinecone RAG Integration** — Replaced the stubbed RAG layer with 
  a production-ready integration using `voyage-finance-2` embeddings and Pinecone vector 
  database. Wired up the backend to asynchronously inject SEC 8-K filings into the vector DB 
  upon scraping. Integrated retrieval directly into `runStrategyOnce`, injecting top candidates' 
  financial context directly into the Bull Agent prompt. See `docs/rollouts/2026-06-18-voyage-pinecone-rag.md`.
- 2026-06-18: **Glassmorphic UI Redesign** — Enhanced the UI aesthetics to a premium, modern 
  glassmorphism design. Updated `globals.css` with animated, vibrant mesh gradient backgrounds 
  and adjusted semantic design tokens (`--surface`, `--line`) to natively use translucent RGBA values. 
  This transforms all existing `bg-surface/50 backdrop-blur` classes across the app into genuine 
  beveled glass panels with inner white/dark highlights. Build is green. See `docs/rollouts/2026-06-18-glassmorphism-ui.md`.
- 2026-06-18: **Multi-account credential hardening + UI clarity fixes** — fixed active-profile
  setting persistence (`user_settings`, not malformed `settings` writes), kept connected-account
  API keys server-only in dashboard snapshots, encrypted connected-account credentials at rest,
  preserved credentials when editing account metadata, made Alpaca use the selected connected
  account credentials, restored a command-bar "Manage Accounts..." escape hatch, and clarified
  symbol drilldown factor values as normalized 0-100 scores. `npx tsc --noEmit`, `npm test`
  (**188 tests**), and `npm run build` pass after deleting stale `.next` output. Dev-server
  follow-up: local `next dev` hit repeated `EMFILE: too many open files, watch` warnings and an
  orphan port-3000 Node listener could not be stopped because escalation was rejected by the
  environment. See `docs/rollouts/2026-06-18-multi-account-hardening-review.md`.
- 2026-06-18: **Markdown documentation audit** — read all repo-authored Markdown
  files (including `CLAUDE.md` symlink and ignored iCloud conflict copies, excluding
  `node_modules`, `.git`, and `.next`) and updated stale current docs. Notable
  findings: `README.md` still pointed to deleted `docs/HANDOFF.md`; Phase 10 was
  stale for later June 18 signal/RAG/UI work; Phase 9 still pointed at `CLAUDE.md`
  instead of `AGENTS.md`; Phase 1/8 needed clearer historical-vs-current framing.
  See `docs/rollouts/2026-06-18-markdown-doc-audit.md`.
- 2026-06-18: **Continuation hardening pass** — updated `.env.example` to match the
  expanded provider surface, fixed the Macro tab's dashboard internals path so it
  does not cast trimmed audit scans into full `MarketScan` data, passed `userId`
  through dashboard prompt/account/run/fill list reads, typed `webSources.technical`,
  and added regression tests proving the OHLC cascade uses Tradier first and
  Marketstack before free sources. See
  `docs/rollouts/2026-06-18-keys-macro-panel-and-history-keys.md`.
- 2026-06-18: **RAG review resolution pass** — closed the prior review items around
  `src/lib/vector-db.ts`: the file is tracked; vector writes now use batched
  `storeContexts` with centralized Pinecone index initialization; SEC 8-K RAG
  context now includes item labels and SEC filing links; retrieved snippets are sent
  as dynamic `retrievedFinancialContext` in the user payload instead of the system
  prompt; `npm run dev` no longer force-kills port 3000 (`npm run dev:clean` is the
  explicit clean-start script). Added direct vector/SEC/strategy prompt tests. Full
  combined worktree verification passed: `npx tsc --noEmit`, `npm test` (195 tests,
  27 files), `npm run build`. See `docs/rollouts/2026-06-18-rag-review-resolution.md`.
- Near-term engineering focus should be hardening Phase 7/8 before Live use:
  broker support confirmation, persistence/accounting checks, strategy-tuning
  tests, and better tests around short/cover and red-team debate behavior.

## Known Risks

- The worktree may be dirty. Check `git status` before assuming a clean base.
- `short` / `cover` support is partly implemented in policy and paper P&L, but
  Live use still needs broker-surface confirmation and persistence/accounting
  review, especially daily-notional tracking in `src/lib/db.ts`.
- `npx tsc --noEmit` can fail when `.next/types/**/*.ts` entries referenced by
  `tsconfig.json` are missing or stale. A fresh `npm run build` regenerates
  them.
- `npx tsc --noEmit` may report a pre-existing `mockFetcher` type mismatch in
  `test/alternative-data.test.ts` unless that file has been addressed directly.
- `npm run build` regenerates `.next/`; restart any running dev server after it.
- If the browser shows plain unstyled HTML, verify
  `/_next/static/css/app/layout.css` is returning `200`; if it returns `404`,
  restart the dev server on `127.0.0.1:3000`.
- If `next dev` repeatedly logs `EMFILE: too many open files, watch`, stop duplicate Node
  listeners on port `3000`, clean stale generated output only if needed, and restart with a
  higher file-descriptor limit or reduced watcher scope. Use `npm run dev:clean` only when
  intentionally clearing port 3000; `npm run dev` is non-destructive. A production
  `npm run build` remains the authoritative verification path.

## Read This First

1. `AGENTS.md`
2. `STATUS.md`
3. `PLAN.md`
4. Relevant `docs/phase-*.md`
   - `docs/phase-8-cockpit-ui.md` for current dashboard UX architecture
5. Latest matching file in `docs/rollouts/`
6. `git log -3` and current diff

## Documentation Rules

- Durable repo instructions belong in `AGENTS.md`.
- Current snapshot belongs here.
- Feature design and architecture belong in `docs/*.md`.
- Chronological implementation notes belong in `docs/rollouts/`.
- Every non-trivial change should leave either a rollout note or an updated
  existing one if the work is part of the same rollout.

## Next Update Triggers

Update this file when any of the following change:

- active implementation focus
- highest-risk known issue
- expected verification workflow
- handoff reading order
- roadmap meaningfully changes
