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
| 4 | Market data and scoring | `docs/phase-4-market-data-scoring.md` | Multi-factor scoring + TTL cache live; Finnhub/FMP/Alpha Vantage/Yahoo enrichment and VIX macro context are wired. 2026-06-16: `fcfYield`/`debtToEquity`/`epsGrowth` now feed `valueScore`/`qualityScore` and the Market Scan table. 2026-06-16 (web-sources): fixed a real bug where the scan merge dropped those fields + `senateTrades` (extracted exhaustive `applyEnrichment`); congressional + SEC-insider overlays now populate `senateTrades`/`insiderSentiment` |
| 5 | Frontend refactor and charts | `docs/phase-5-dashboard-refactor.md` | Partially implemented; dashboard charts, market-scan columns, activity feed, and kill-switch confirmation are live |
| 6 | Customization and notifications | `docs/phase-6-customization-risk-notifications.md` | Partially implemented; profiles, risk controls, and webhook settings exist; notification polish remains |
| 7 | AI strategy learning loop | `docs/phase-7-strategy.md` | In progress; trade-thesis metadata, red-team debate hook, and learning-loop scaffolding exist. Outcome-aware thesis/regime/sector scorecards, Bayesian shrinkage, `candidates_considered`, `signal_snapshot`, chosen+skipped EvidenceDigest, signal-efficacy, confidence-calibration, and a 20-lot tuner gate are live. Remaining: persisted MAE/MFE per closed lot, counterfactual skipped-name returns, factor-bucket learning, richer per-document digests, and more tests around short/cover + red-team fallback behavior. |
| 8 | Cockpit UI and Strategy Studio | `docs/phase-8-cockpit-ui.md` | Cockpit shell, tabs, Strategy Studio, and strategy tuning API are live. 2026-06-16: full redesign on branch `ui-redesign` — Tailwind 4 + Recharts + Motion, dark/light themes, command bar + Portfolio rail + tabbed workspace, slide-over feeds, modal settings, ⌘K palette, learning-loop charts. Strategy-tuning tests still pending |
| 9 | Backend web sources (scraped signals) | `docs/phase-9-web-sources.md` | 2026-06-16/17 (branch `web-sources`): `src/lib/web-sources/` reads no-free-API signals server-side — Senate eFD + Capitol Trades **congressional trades**, **SEC EDGAR Form 4** insider, and **FINRA daily short-volume** — with polite cached fetch, persistent daily refresh, scheduler hook, event candidate union, source attribution, scan/prompt/UI wiring, and a never-fabricate guarantee. Also: fixed the dropped-enrichment-field bug, plumbed technical/risk fields, `signal_snapshot` audit, thesis×regime + signal-efficacy + confidence-calibration learning, 20-lot gate, edge-aware sizing. Follow-ups now tracked in Phase 10 |
| 10 | Stronger signals, learning & UI (v2 plan) | `docs/phase-10-signals-learning-ui-v2.md` | In progress on `phase-10`: positioning/smart-money deterministic sub-score, sector scorecard, full EvidenceDigest for chosen+skipped, SEC 8-K coarse bulletins, market breadth/internals, expanded FRED/macro metrics, Macro tab, Fama-French, Cboe SKEW/VVIX, CFTC COT, technical signals, keyed OHLC cascade, RAG scaffold, symbol drilldown, and price chart are live. Remaining: counterfactual skipped-name returns, factor-bucket learning, adaptive prompt compaction/cache layout, production-grade document digests/RAG, analyst/earnings revisions, SEC XBRL facts, full learning-matrix UI, exposed scoring thresholds, and de-risk-in-crisis guardrail. |
| 11 | Multi-user & API-key management (plan) | `docs/phase-11-multi-user.md` | In progress: default-user scaffolding exists; connected brokerage accounts now keep API keys server-only in dashboard snapshots, encrypt stored credentials, preserve credentials on metadata edits, and route Alpaca through the active connected account. Remaining: a full API Keys settings tab, provider-wide `resolveApiKey(service,userId)` routing, full user policy/data isolation, concurrent per-user scheduling, then identity/auth. |

## Build Order

1. Phase 1 hardening: scheduler starts once, run lock works, market-hours state is visible.
2. Phase 2 correctness: estimated notional is authoritative and sector attribution covers all scan rows.
3. Phase 3 performance: snapshots, fills, paper/live P&L, and run attribution.
4. Phase 4 data/scoring: provider abstraction, quote enrichment, TTL cache, factor scores.
5. Phase 5 dashboard: typed components, charts, visible loading/error states, better allowlist UX.
6. Phase 6 customization: profiles, deterministic risk rules, webhook notifications.
7. Phase 7 strategy loop: persist learning metrics, harden red-team debate fallback, and keep short/cover disabled for Live until broker/accounting behavior is proven.
8. Phase 8 cockpit UX: harden strategy tuning tests, polish pane density, and add persisted tuning history if audit needs justify it.

## Acceptance Checks

- The strategy can run autonomously while enabled, without opening the dashboard.
- `strategy_run` audit events are written inside `runStrategyOnce()` and only once per executed run.
- Daily limits count reviewed `estimated_notional`, including share-quantity market orders.
- Held positions can be attributed to sectors even when they are not top scan candidates.
- Performance summaries separate live and paper results.
- Scan candidates expose provider freshness, factor score breakdowns, and bid/ask data when available.
- Dashboard shows market session, scheduler state, performance charts, active profile, risk settings, and notification status.
- Desktop dashboard fits in one viewport with internal pane scrolling and tabbed workspaces.
- Strategy tuning proposals are review-only until the user explicitly applies them.
- Policy enforcement deterministically handles daily limits, symbol limits, sector caps, stop-loss, and take-profit rules.
- Webhook notifications are attempted only when configured and every attempt is audited.
