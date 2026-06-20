# Improvement Plan - Robinhood Agentic Dashboard

Eight-phase roadmap to make the dashboard genuinely autonomous, more accurate,
measurable, customizable, and easier to operate. The current codebase is treated
as partially complete; implementation should preserve working controls while
filling the missing pieces.

## Current Status

| # | Phase | Spec | Status |
|---|-------|------|--------|
| 1 | Autonomy loop | `docs/phase-1-autonomy-loop.md` | Mostly implemented; hardening/tests remain |
| 2 | Correctness fixes | `docs/phase-2-correctness.md` | Partially implemented; sector attribution incomplete |
| 3 | Performance tracking | `docs/phase-3-performance.md` | Partially implemented; paper portfolio projection and short/cover P&L branches exist, persistence/attribution hardening remains |
| 4 | Market data and scoring | `docs/phase-4-market-data-scoring.md` | Multi-factor scoring + TTL cache live; Finnhub/FMP/Alpha Vantage/Yahoo enrichment and VIX macro context are wired. 2026-06-16: `fcfYield`/`debtToEquity`/`epsGrowth` now feed `valueScore`/`qualityScore` and the Market Scan table. 2026-06-16 (web-sources): fixed a real bug where the scan merge dropped those fields + `senateTrades` (extracted exhaustive `applyEnrichment`); congressional + SEC-insider overlays now populate `senateTrades`/`insiderSentiment`. 2026-06-19: optional `webull-unofficial` quote enrichment is available for read-only market fields only, disabled by default and never used for execution/fills. 2026-06-19: quote-source attribution now derives broker providers (`alpaca-quotes`, `robinhood-quotes`), OHLC cache sharing is explicit, shared history fills can fulfill pending misses, and Massive grouped daily VWAP can enrich scan rows when available. |
| 5 | Frontend refactor and charts | `docs/phase-5-dashboard-refactor.md` | Partially implemented; dashboard charts, market-scan columns, activity feed, kill-switch confirmation, actionable scan empty states, and readable activity summaries are live |
| 6 | Customization and notifications | `docs/phase-6-customization-risk-notifications.md` | Partially implemented; profiles, risk controls, and webhook settings exist; notification polish remains |
| 7 | AI strategy learning loop | `docs/phase-7-strategy.md` | In progress; trade-thesis metadata, red-team debate hook, and learning-loop scaffolding exist. Outcome-aware thesis/regime/sector scorecards, Bayesian shrinkage, `candidates_considered`, `signal_snapshot`, chosen+skipped EvidenceDigest, signal-efficacy, confidence-calibration, durable skipped-name counterfactual materialization, and a 20-lot tuner gate are live. Remaining: persisted MAE/MFE per closed lot, post-mortem/tuning use of materialized missed opportunities, richer per-document digests, and more tests around short/cover + red-team fallback behavior. |
| 8 | Cockpit UI and Strategy Studio | `docs/phase-8-cockpit-ui.md` | Cockpit shell, tabs, Strategy Studio, and strategy tuning API are live. 2026-06-16: full redesign on branch `ui-redesign` — Tailwind 4 + Recharts + Motion, dark/light themes, command bar + Portfolio rail + tabbed workspace, slide-over feeds, modal settings, learning-loop charts. 2026-06-19/20: first-run setup state, Test/Paper/Brokerage legibility, mobile scroll recovery, compact mobile portfolio summary, grouped Operate universe controls with a one-time S&P 500 default migration, Smart Money ticker drawer fallback, and a persisted ticker-logo display preference are live. Strategy-tuning tests still pending |
| 9 | Backend web sources (scraped signals) | `docs/phase-9-web-sources.md` | 2026-06-16/17 (branch `web-sources`): `src/lib/web-sources/` reads no-free-API signals server-side — Senate eFD + Capitol Trades **congressional trades**, **SEC EDGAR Form 4** insider, and **FINRA daily short-volume** — with polite cached fetch, persistent daily refresh, scheduler hook, event candidate union, source attribution, scan/prompt/UI wiring, and a never-fabricate guarantee. Also: fixed the dropped-enrichment-field bug, plumbed technical/risk fields, `signal_snapshot` audit, thesis×regime + signal-efficacy + confidence-calibration learning, 20-lot gate, edge-aware sizing. Follow-ups now tracked in Phase 10 |
| 10 | Stronger signals, learning & UI (v2 plan) | `docs/phase-10-signals-learning-ui-v2.md` | In progress on `phase-10`: positioning/smart-money deterministic sub-score, sector scorecard, full EvidenceDigest for chosen+skipped, SEC 8-K bulletins with item-label enrichment, market breadth/internals, expanded FRED/macro metrics, Macro tab, Fama-French, Cboe SKEW/VVIX, CFTC COT, technical signals, keyed OHLC cascade, batched Voyage/Pinecone RAG scaffold with paced/capped 8-K ingestion, 2026-06-20 tenant-safe RAG metadata/filter/backoff hardening with raw-user credential lookup preservation, symbol drilldown with 0-100 signal thresholds, price chart with VWAP overlay, Market Scan `vs VWAP`, first-pass prompt compaction, factor-bucket scorecards, current-scan skipped counterfactual summaries, durable/mature-horizon skipped-name counterfactual rows, configurable red-team conviction threshold, and an optional de-risk-in-crisis opening-exposure cap are live. Remaining: broader adaptive prompt compaction/cache layout, production-grade filing/news digests, analyst/earnings revisions, SEC XBRL facts, post-mortem/tuning use of missed-opportunity rows, full learning-matrix UI, and broader scoring-threshold settings. |
| 11 | Multi-user & API-key management (plan) | `docs/phase-11-multi-user.md` | In progress: default-user scaffolding exists; connected accounts now keep API keys server-only in dashboard snapshots, encrypt stored credentials, preserve credentials on metadata edits, route Alpaca through the active connected account, sync Robinhood through MCP OAuth/status instead of manual keys, derive execution state as Test vs Paper vs Brokerage, present supported account connect buttons in Accounts, keep Paper accounts optional and user-selected, expose a hardened Robinhood MCP HTTP/SSE transport plus `/api/broker/mcp/health`, show Robinhood MCP status in Accounts, ship Settings → API Keys, route major provider/LLM calls through `resolveApiKey(service,userId)`, scope strategy locks, paper projections, learning scorecards, tax reads, notifications, reflections, dashboard callbacks, and prompt cache keys by user, route high-impact API handlers through `resolveRequestUserId` with `local` fallback, explicitly share public/env-key market data while keeping user-keyed history private by default, track pending public OHLC misses so later shared fills can refresh prior requesters without spending another user's key, and add Infisical wrappers, local Gitleaks scanning, Sentry runtime hooks, redacted Langfuse LLM traces, npm Dependabot, Litestream scripts, and Playwright smoke tests. GitHub CI/e2e/security workflows are deferred until push credentials include `workflow` scope. Remaining: complete policy/data isolation audit, bounded concurrent scheduling, then real identity/auth. |
| 12 | Architecture Blueprint | `docs/architecture-blueprint.md` | Drafted 2026-06-20 as a target technical blueprint for tri-state execution, trailing stops, IRA taxation, multi-tenant RAG, and LLM reasoning. First runtime foundations are live for tri-state execution, LLM request caps, and tenant-safe RAG; trailing stops, IRA taxation, and deeper prompt caching remain design targets. |

## Build Order

1. Phase 1 hardening: scheduler starts once, run lock works, market-hours state is visible.
2. Phase 2 correctness: estimated notional is authoritative and sector attribution covers all scan rows.
3. Phase 3 performance: snapshots, fills, Test vs broker-routed P&L, and run attribution.
4. Phase 4 data/scoring: provider abstraction, quote enrichment, TTL cache, factor scores.
5. Phase 5 dashboard: typed components, charts, visible loading/error states, better universe/watchlist UX.
6. Phase 6 customization: profiles, deterministic risk rules, webhook notifications.
7. Phase 7 strategy loop: persist learning metrics, harden red-team debate fallback, and keep short/cover disabled for Live until broker/accounting behavior is proven.
8. Phase 8 cockpit UX: harden strategy tuning tests, polish pane density, and add persisted tuning history if audit needs justify it.

## Acceptance Checks

- Required handoff verification remains: `npx tsc --noEmit`, `npm test`, then
  `npm run build`. GitHub Actions CI should mirror that sequence once workflow
  files can be pushed with credentials that include `workflow` scope.
- The strategy can run autonomously while enabled, without opening the dashboard.
- `strategy_run` audit events are written inside `runStrategyOnce()` and only once per executed run.
- Daily limits count reviewed `estimated_notional`, including share-quantity market orders.
- Held positions can be attributed to sectors even when they are not top scan candidates.
- Performance summaries separate live and paper results.
- Scan candidates expose provider freshness, factor score breakdowns, and bid/ask data when available.
- Dashboard shows market session, scheduler state, performance charts, active profile, risk settings, and notification status.
- Desktop dashboard fits in one viewport with internal pane scrolling and tabbed workspaces.
- Mobile and tablet layouts use normal page scrolling with the fixed cockpit
  shell reserved for desktop widths.
- Strategy tuning proposals are review-only until the user explicitly applies them.
- Policy enforcement deterministically handles daily limits, symbol limits, sector caps, stop-loss, and take-profit rules.
- Webhook notifications are attempted only when configured and every attempt is audited.
- Error/LLM observability stays opt-in and redacted by default for account, prompt, and credential data.
- The local SQLite database has a documented Litestream replicate/restore path before production reliance.
- Root-level manual probe artifacts such as screenshots, one-off UI scripts, and
  accidental shell-output files stay ignored so the integration worktree remains
  reserved for review and merges.
