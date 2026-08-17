# 2026-08-17 — Alert-noise leftover: retired FilingAPI + soft-limit ops + live boot pages

## Context & Objective

Owner All Messages screenshot at 4:23–4:38pm CT (2026-08-17) stacked connection-failed,
budget, Litestream, and UptimeRobot cards.  Live evidence at 21:42Z showed Socratic.Trade
healthy after the 21:35:38Z Coolify restart of `5f9b4aaf`.  Goal: stop leftover FilingAPI
401s and expected-limit 429s from looking like outages, and stop the live boot window from
paging every probe that 5xxs during a deploy.

## Changes Made

- `getServiceHealthSummaries` now stamps `intentionalOff` for retired vendors (FMP / Quiver /
  Unusual Whales / FilingAPI) and clears STOPPED.  Leftover `api_health_log` 401s after the
  2026-08-17 FilingAPI retire no longer appear as a live dependency failure.
- Ops snapshot `ok` matches `/api/health`: only a hard 5-streak fails.  Soft "no success this
  hour" / expected-limit 429s stay diagnostic (`lastFailure`) without `ok: false`.
- Public `/api/health` omits retired vendors from `checks.dependencies`.
- `alertConnectionFailure` is silent for the first 5 minutes when `DB_BOOTSTRAP=live` (Coolify
  production).  Tests and local/dev are unchanged.  Override:
  `HEALTH_ALERT_STARTUP_GRACE_SECONDS`.

Touched files:

- `src/lib/db-health.ts`
- `src/lib/ops-snapshot.ts`
- `app/api/health/route.ts`
- `test/health-lane-cap.test.ts`
- `test/ops-snapshot.test.ts`
- `test/health-alert-noise-gate.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- this note

## Decisions & Trade-offs

- Did not raise Pinecone / Anthropic / Alpha Vantage budgets.  Those cards are working
  fuses, not outages.
- Did not treat the 1-minute congress.trade UptimeRobot blip as a product bug.  It lined up
  with the Coolify restart; CT `/api/health` is 200 again.  CT autopilot remains stalled on
  an OpenRouter files-endpoint prepaid minimum (owner billing, not this repo).
- Did not rotate Alpaca keys.  Trading liveness shows 2 Autopilot accounts; the env-lane 401
  in the screenshot is consistent with boot probes against a stale Infisical env key while
  Connections user keys still trade.
- Startup grace is live-only so the existing hard-streak tests keep paging.

## Verification State

Commands actually run on this branch:

```bash
npm run lint
npx tsc --noEmit
./node_modules/.bin/vitest run test/health-alert-noise-gate.test.ts \
  test/health-lane-cap.test.ts test/ops-snapshot.test.ts \
  test/retired-direct-vendors.test.ts test/connections-health-route.test.ts
```

Lint exit 0 (warnings only).  tsc exit 0.  Targeted: 5 files / 37 passed.

`test/connection-health-routing.test.ts` has 5 pre-existing failures in this cloud VM
(Pushover preferred over Resend; `RAG_EMBED_PROVIDER=siliconflow`).  Not caused by
this change; not used as the gate.

## Next Steps & Blockers

- After merge: leftover Infisical `FILINGAPI` can stay unused.  Do not buy Plus.
- Owner (Usage Monitor, not this repo): Anthropic monthly $120 / $100 and the
  forecast/restart/cooldown provider budget cards.
- Owner (Congress.Trade): OpenRouter files-endpoint prepaid minimum is holding autopilot.
  Latest transaction is 147h old.
- Residual ST money-path (already on main, not this PR): Green Team still failed earlier
  today on `mistral-small-2603` (not on the OpenRouter account) and `gpt-5.6-terra` /
  `gpt-5.6-luna` 400 Provider returned error.  Mistral Medium slug remap is already live.

## Zero-Code Findings

Live at 2026-08-17T21:42Z (`/api/health` + ops snapshot):

| Card in the screenshot | Verdict |
|---|---|
| Litestream L1 stale / L2+L3 empty / state unreachable | Boot.  All five tiers known, not degraded, L0 age 0s. |
| congress.trade 502 + UptimeRobot down 1m | Deploy gap.  CT health 200; pipeline still stalled on billing. |
| nasdaq-quote / vix / polymarket / apify / alpaca-broker 5xx/401/404 | Probe failures during the 21:35:38Z restart of `5f9b4aaf`.  Lanes ok after. |
| vix-yahoo "not ok" on ops snapshot | Expected-limit HTTP 429 + soft "no success in 60 min".  CBOE-first VIX is fine. |
| filingapi HTTP 401 | Retired vendor.  Leftover health rows only.  No live HTTP. |
| Pinecone WU daily fuse / monthly 2M | App fuse at trial cap.  Retrieval still works.  Do not raise. |
| Alpha Vantage 25/day pool exhausted | Expected free-tier cap. |
| Siliconflow RAG embed-budget | Expected ingest park. |
| Anthropic $120 / $100 | Usage Monitor budget, not Socratic.Trade. |
| Scheduler / Autopilot | Ticking.  2 Autopilot accounts.  Market closed. |
