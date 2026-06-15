# Improvement Plan - Robinhood Agentic Dashboard

Six-phase roadmap to make the dashboard genuinely autonomous, more accurate,
measurable, customizable, and easier to operate. The current codebase is treated
as partially complete; implementation should preserve working controls while
filling the missing pieces.

## Current Status

| # | Phase | Spec | Status |
|---|-------|------|--------|
| 1 | Autonomy loop | `docs/phase-1-autonomy-loop.md` | Mostly implemented; hardening/tests remain |
| 2 | Correctness fixes | `docs/phase-2-correctness.md` | Partially implemented; sector attribution incomplete |
| 3 | Performance tracking | `docs/phase-3-performance.md` | Not complete |
| 4 | Market data and scoring | `docs/phase-4-market-data-scoring.md` | Multi-factor scoring + TTL cache live; news sentiment + P/E via `FMP_API_KEY` (`src/lib/data-providers.ts`), neutral fallback without a key |
| 5 | Frontend refactor and charts | `docs/phase-5-dashboard-refactor.md` | Not complete |
| 6 | Customization and notifications | `docs/phase-6-customization-risk-notifications.md` | Not complete |

## Build Order

1. Phase 1 hardening: scheduler starts once, run lock works, market-hours state is visible.
2. Phase 2 correctness: estimated notional is authoritative and sector attribution covers all scan rows.
3. Phase 3 performance: snapshots, fills, paper/live P&L, and run attribution.
4. Phase 4 data/scoring: provider abstraction, quote enrichment, TTL cache, factor scores.
5. Phase 5 dashboard: typed components, charts, visible loading/error states, better allowlist UX.
6. Phase 6 customization: profiles, deterministic risk rules, webhook notifications.

## Acceptance Checks

- The strategy can run autonomously while enabled, without opening the dashboard.
- `strategy_run` audit events are written inside `runStrategyOnce()` and only once per executed run.
- Daily limits count reviewed `estimated_notional`, including share-quantity market orders.
- Held positions can be attributed to sectors even when they are not top scan candidates.
- Performance summaries separate live and paper results.
- Scan candidates expose provider freshness, factor score breakdowns, and bid/ask data when available.
- Dashboard shows market session, scheduler state, performance charts, active profile, risk settings, and notification status.
- Policy enforcement deterministically handles daily limits, symbol limits, sector caps, stop-loss, and take-profit rules.
- Webhook notifications are attempted only when configured and every attempt is audited.
