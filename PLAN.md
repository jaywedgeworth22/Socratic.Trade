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
| 4 | Market data and scoring | `docs/phase-4-market-data-scoring.md` | Multi-factor scoring + TTL cache live; Finnhub/FMP/Alpha Vantage/Yahoo enrichment and VIX macro context are wired |
| 5 | Frontend refactor and charts | `docs/phase-5-dashboard-refactor.md` | Partially implemented; dashboard charts, market-scan columns, activity feed, and kill-switch confirmation are live |
| 6 | Customization and notifications | `docs/phase-6-customization-risk-notifications.md` | Partially implemented; profiles, risk controls, and webhook settings exist; notification polish remains |
| 7 | AI strategy learning loop | `docs/phase-7-strategy.md` | In progress; trade-thesis metadata, red-team debate hook, and learning-loop scaffolding exist. 2026-06-16: outcome-aware Thesis Scorecard now feeds realized per-thesis P&L back into the Bull/reflection prompts; post-mortem gated; prompt context trimmed. MAE/MFE excursion persistence still a stub |
| 8 | Cockpit UI and Strategy Studio | `docs/phase-8-cockpit-ui.md` | Cockpit shell, tabs, Strategy Studio modal/tab, and strategy tuning proposal API are live; UI hardened 2026-06-16 (toast-stack alerts, modal/tab accessibility, inline-style→CSS-class refactor); strategy-tuning tests still pending |

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
