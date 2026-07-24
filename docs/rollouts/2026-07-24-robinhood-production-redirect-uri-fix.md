# 2026-07-24 - Robinhood MCP Production Redirect URI & Loopback Fix

## Context & Objective

When attempting to reconnect Robinhood from `socratictrade.com`, the browser was redirected to `http://localhost:4000/api/auth/robinhood/callback?code=...&state=...`, resulting in Safari error "Safari Can't Connect to the Server 'localhost'".
The objective was to fix Infisical production secrets for Socratic.Trade (`39d93bb7-76f9-498c-8b50-a7def52e072f`) so Robinhood OAuth redirects back to `https://socratictrade.com/api/auth/robinhood/callback`.

## Changes Made

- Updated Infisical `prod` secrets for Socratic.Trade (`39d93bb7-76f9-498c-8b50-a7def52e072f`):
  - `ROBINHOOD_MCP_REDIRECT_URI` updated to `https://socratictrade.com/api/auth/robinhood/callback` (previously set to `http://localhost:4000/api/auth/robinhood/callback`).
  - `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT` updated to `off` (previously set to `on`).
- Triggered Coolify deployment for `socratic-trade-prod` (`m1os7ijf31bg3fanil152e4b`) to load the updated secrets.

## Decisions & Trade-offs

- The loopback redirect mode (`ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=on` + `ROBINHOOD_MCP_REDIRECT_URI=http://localhost:4000/...`) was originally intended for local dev overrides, but was active in `prod` environment. Disabling loopback override in `prod` ensures public production users are always redirected back to `https://socratictrade.com/api/auth/robinhood/callback`.

## Verification State

- Verified Infisical API secret update: `ROBINHOOD_MCP_REDIRECT_URI=https://socratictrade.com/api/auth/robinhood/callback` and `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=off`.
- Triggered deployment `mqo207mkfra3j6lsme6dpxru` for `socratic-trade-prod` on Coolify.
- Tested OAuth URL construction logic: `redirect_uri` parameter is set to `https://socratictrade.com/api/auth/robinhood/callback`.

## Next Steps

- Once Coolify deployment finishes, reconnect Robinhood from `https://socratictrade.com/accounts`.
