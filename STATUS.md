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
- Latest completed design area in docs: `docs/phase-8-cockpit-ui.md` describes
  the single-screen cockpit UI and Strategy Studio review/apply workflow.
- Cloud branch: `codex/upload-current-state` is pushed to `origin`.
- Draft PR: https://github.com/jaywedgeworth22/robinhood-agentic-trading/pull/2

## Active Focus

- 2026-06-17: Active dev is on branch **`phase-10`**, executing
  `docs/phase-10-signals-learning-ui-v2.md` (status markers in that doc are the
  source of truth for what's next). `phase-10` is a strict descendant of
  `web-sources` and of `main`, so it **fast-forward-merges into `main`** — this is
  now the canonical merge (it supersedes the old "merge web-sources → main", F3).
  Done so far on `phase-10`: **A1** positioning ScoringWeights sub-score (scraped
  smart-money signals now move the deterministic score + re-rank after overlay);
  **B1** sector learning dimension (`getSectorScorecard` → prompt); **C1** SEC 8-K
  catalyst connector (`web-sources/sec8k.ts`, 94 live events); **C2** market breadth
  (`breadthPct` on `MarketScan`). Plus the share-quantity number policy finalized:
  **records keep full double precision; display = 3 sig figs OR all whole-number
  digits, whichever is larger, comma-grouped** (`formatQuantity`; see
  `docs/rollouts/2026-06-17-quantity-precision-display.md`). Next per the plan:
  **B2** full EvidenceDigest (chosen + skipped), then D1/D2 prompt efficiency,
  E1/E2 UI, remaining C sources. Also planned: `docs/phase-11-multi-user.md`
  (per-user keys/preferences; API-keys settings section first). 136 tests; tsc +
  build green. Git commits use the CLT workaround
  (`DEVELOPER_DIR=/Library/Developer/CommandLineTools`) until the Xcode license is
  accepted. iCloud sync-conflict files (`"<name> 2.<ext>"`) are now gitignored.
- Current publish branch packages the latest dashboard, cockpit UI,
  market-data, strategy, short/cover, and handoff-doc work for review.
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
  `docs/phase-9-web-sources.md`. Branch not yet pushed/merged.
- 2026-06-17: Phase 10 (E1) - Symbol Drilldown Drawer. Added a clickable row action to `MarketScanView` that slides out a `SymbolDrilldown` drawer. Shows factor breakdown waterfall, provenance mappings, and an AI Conviction summary. See `docs/rollouts/2026-06-17-symbol-drilldown-drawer.md`.
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
