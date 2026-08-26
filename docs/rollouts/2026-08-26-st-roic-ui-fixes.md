# 2026-08-26 — ROIC.ai and EarningsCalls.dev Settings and Admin UI updates

## Context & Objective
The user noted that they have switched to ROIC.ai, and asked that the EarningsCalls alert be clarified to explicitly say `EarningsCalls.dev` and requested that `ROIC.ai` be added both below it in Settings and in the Admin page to display its request rates and status.

## Changes Made
- `app/console/settings/page.tsx`, `src/lib/dashboard-ui.ts`, `app/console/components/alert-center.tsx`: Updated notification strings from `EarningsCalls` to `EarningsCalls.dev` for clarity.
- `src/lib/types.ts`, `src/lib/db.ts`, `src/lib/db-notifications.ts`: Registered a new `roic_status_advisory` notification type so that ROIC.ai appears directly under EarningsCalls.dev in the alerts list.
- `app/api/admin/connections-health/route.ts`: Aliased `roic` to `roic.ai` and added it to `EXPECTED_BACKEND_LANES` so it explicitly appears in the Admin page's API Connections card with its 24h request rate and status.

## Decisions & Trade-offs
- No direct code changes to ROIC's execution engine were made; this was purely to enhance UI visibility and explicitly track its health rate in the admin panel.

## Next Steps
- Merge to main.
