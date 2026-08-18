# 2026-08-18 — Live prod triage + Alpaca getAccount cache

## Context & Objective

Owner asked to troubleshoot live Socratic.Trade issues because the prior Grok seat was too slow.  Autopilot was degraded during RTH.  This note is the triage receipt plus the one unclaimed code fix.

## Changes Made

Live (ops snapshot `2026-08-18T19:56Z`, health sha `6429d984` at start of the session):

- Site up.  Scheduler ticking.  OpenRouter credits ok.  Pinecone trial still open (~$256 / 12d).
- Autopilot accounts: Alpaca Paper + Roth IRA.  Paper had 4 consecutive Green failures (`gpt-5.6-terra` / `gpt-5.6-luna` 400 "Provider returned error", then a fake "Failover chain exhausted (3 Green Team endpoints)" after one stored call).  Roth completed at 19:43Z with 0 proposals.
- Scan has returned 0 quotes since 2026-08-13 (Nasdaq screener still used stub UA).  That is why a successful Green run proposes 0 trades.
- Roth dashboard `getAccounts` 6s timeouts all day.  Cause: dashboard/strategy `Promise.all` `getAccounts` + `getPortfolio`, each calling Alpaca `GET /v2/account`.
- Litestream L2/L3 still wedged (~13h).  Owner-ops.  L0 + L9 healthy.  Not touched.
- 19:16Z 19m 503 paired with the OpenRouter-credits monitor was a deploy window of #2829.  #2812 (rag-embed soft-degrade) merged during this session so one dead embed no longer 503s Docker.

Landed-by-rematch (Cursor code, Grok rematch only):

- **#2831** Green 400 failover + do not pick terra first — rematched onto `main` after #2812.  Auto-merge armed.
- **#2830** Nasdaq screener UA + retry so Scan returns names — phantom CONFLICTING; rematched.  Auto-merge armed.

This branch's code: coalesce in-flight Alpaca `getAccount()` and reuse a 15s TTL so one dashboard load / one strategy run pays for one account GET.

Touched files:

- `src/lib/alpaca.ts`
- `test/alpaca-account-cache.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-18-prod-triage-alpaca-account-cache.md`

## Decisions & Trade-offs

- Did not rewrite #2831 / #2830.  Those already fix Green 400 and empty Scan.
- Did not touch Litestream L2/L3 B2 (owner-ops; rolling-deploy double writer).
- 15s TTL is only long enough to collapse one UI load / one strategy `Promise.all`.  Buying-power for orders still comes from the same cached account object during that window.
- Cache key is `userId|connectedAccountId|environment`.  No secret material.

## Verification State

```bash
npx vitest run test/alpaca-account-cache.test.ts
npx tsc --noEmit
```

(Full lint / test / build run before land.)

## Next Steps & Blockers

- Confirm #2831 and #2830 merge + auto-deploy, then verify Paper Green failovers and Scan returns names.
- After those land, Autopilot should propose again.  If Paper still fails, the next live 400 slug needs a new seat drop.
- L2/L3 wedge remains owner-ops.

## Zero-Code Findings

Sentry `OpenRouter embed/rerank connection failed` + `Pinecone connection failed` at 19:41Z share one trace and `reason=fetch failed` / `terminated`.  Same class as prior deploy/socket-death, not a new vendor outage.  Embed `key_source=none` is the system lane, not a missing Connections key.
