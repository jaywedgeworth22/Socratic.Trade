## 2026-07-30 — Rule Significance Testing (Jesse label-permutation baseline) (KIMI) — PR #2294

OSS-lessons §6 slice 1 of 3. Track-record facts ingested into learned context now carry an honest significance sentence: does the thesis bucket's mean realized return beat a random same-size bucket of the pooled tagged closed-lot history (label-permutation null, 1000 permutations, +1 correction)? Confidence scales — 0.7 when the edge is unlikely to be luck, 0.45 when luck isn't ruled out (fact still written; annotation not hard-gate). New pure `src/lib/significance.ts` (injectable rng, pool-size floor) + `poolClosedLotReturnsByThesis` wiring in `post-mortem.ts`. Sentence digits are bare p-value + permutation count only — test-verified `classifyRiskTier` keeps it a fact. 15 new tests. All gates green: tsc exit 0, lint 0 errors (3 pre-existing warnings, down from 4), 22/22 targeted, full suite 5446/5446 (3 shards), build exit 0. Branch `kimi/rule-significance`. Rollout: `docs/rollouts/2026-07-30-rule-significance.md`. Slices 2-3 (TraderHarness PIT masking, qlib walk-forward) remain planned/unassigned.

## 2026-07-30 — Pushover Notification Channel Support (ANTIGRAVITY, branch `agent/antigravity-pushover`)
## 2026-07-29 — Adjusted Day P&L for Cash Flows (ANTIGRAVITY, branch `agent/ag-day-pnl`)

Updated `deriveDayPnl` to correctly handle intraday cash deposits and withdrawals by reusing the `inferExternalCashFlows` helper from the benchmark engine. The dashboard will now compute P&L correctly by netting out any cash flows, preventing the UI from misattributing cash deposits as profit.

Tests and build are green. Rollout: `docs/rollouts/2026-07-29-day-pnl-cash-flow-adjusted.md`.

## 2026-07-29 — Expose Portfolio Errors in UI (ANTIGRAVITY, branch `agent/ag-portfolio-error`)

Exposed `getPortfolio` failure errors directly in the UI instead of silently swallowing them and showing the default $1,000 policy limit. The exact error (e.g. Robinhood agentic MCP failure) will now render as a warning chip so the user can diagnose connections issues quickly.

All 5431 tests and the Next.js build passed cleanly. Rollout: `docs/rollouts/2026-07-29-portfolio-error-ui.md`.

## 2026-07-30 — Coolify token split + Infisical guardrails (GROK)

Added Pushover as a standalone notification channel inside `notification_prefs`:
1. Updated types `NotifyPrefs` and `NotifyChannelId` in `src/lib/types.ts`.
2. Created a new SQLite migration `063-notification-prefs-pushover.sql` and appended versioned migration 63 to `src/lib/db.ts` to add the `pushover_target` column. Also hardened the migration to support isolated partial test schemas.
3. Updated `app/console/settings/delivery.tsx` and `lib.ts` to allow configuring the Pushover User Key.
4. Separated out Pushover from the legacy ntfy Push system in `src/lib/notify.ts` to construct its own dedicated REST POST payload to `api.pushover.net`.
5. Updated `src/lib/db-api-keys.ts` to save and extract the target appropriately.

All 5000+ tests, the TypeScript compiler, and the linter pass. Changes pushed and merged via `scripts/land.sh`.

## Blockers
- None.

## Next Action
- Wait for user instructions or close ticket.
