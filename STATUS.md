# Status

Current snapshot for fast handoff across Codex, Claude, Cursor, Gemini, or a
human contributor. Update this when active focus, risks, or near-term next
steps materially change.

## Current State

- App: local-only Next.js Robinhood agentic trading dashboard with paper/live
  mode separation, policy gating, equity-only execution, and a phase-based
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
- 2026-06-18: Added a **standalone hosted preview** — pm2 app `trading-preview` on
  **port 4100**, running `next start` from its own worktree `~/apps/trading-preview`
  (detached on `main`), fully decoupled from the agent-edited worktree and from any
  agent's session/`.next`. Refresh it with `scripts/refresh-preview.sh [ref]`. This
  replaces relying on session-bound dev servers for browser checks; see the rewritten
  "Hosting & dev servers" section in `AGENTS.md`. Key rule for all agents: a running
  dev/preview port is NOT a work lock — coordinate via git + STATUS.md only.
- **Data Optimization**: Market Scan candidates with a score < 40 are filtered out backend-side. The JSON payload is heavily minified (`symbol` -> `sym`, `marketCap` -> `mktCap`) to save LLM context window tokens.
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
