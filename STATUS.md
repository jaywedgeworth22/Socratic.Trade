## 2026-07-31 — Fix admin.socratictrade.com DNS 525 Error & Host Routing (ANTIGRAVITY)

Fixed Cloudflare Error 525 (SSL Handshake Failed) on `admin.socratictrade.com` by adding `admin.socratictrade.com` and `*.socratictrade.com` to `/etc/usage-monitor/Caddyfile` on Oracle Cloud (`141.148.182.224`) and reloading Caddy. Also added middleware host routing in `middleware.ts` so `admin.socratictrade.com/` redirects directly to `/admin` and shorthand paths redirect to `/admin/<subpath>`.

All 4,893 tests, lint, tsc, and Next.js build pass cleanly. Rollout: `docs/rollouts/2026-07-31-admin-dns-routing-fix.md`.

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

All 5000+ tests, the TypeScript compiler, and the linter pass. Changes are currently landing via `scripts/land.sh`.

## Blockers
- None for this worktree, but `land.sh` is currently running and merging into `main`. Wait for it to finish.

## Next Action
- **For Kimi (Next Agent):**
  1. Wait for `land.sh` to finish merging in the `trading-antigravity` lane.
  2. Sync your `~/apps/trading-kimi` worktree with `origin/main` to pick up migration 63 and the Pushover UI before starting new work.
