# 2026-08-17 — ST tolerates slow/flappy Congress.Trade and Usage-Monitor lanes (#2550)

## Context & Objective

Prod 2026-08-06 saw `congress.trade` answer in 11s and Usage-Monitor in 6.9s (~478
calls/hr from ST).  SSE flaps paged as `provider_degraded`.  ST must keep the
console up and stop hammering those peer lanes.  This repo does not change CT/UM
servers.

## Changes Made

Shared process-local latency tracker (`src/lib/peer-lane-backoff.ts`): p50 over
the last 8 samples.  Delay multiplier is 1x when healthy, 2x when p50 > 2s, 4x
when p50 > 4s.  After 15 minutes without a new sample the lane is probed again.

- Usage-Monitor knobs: failure backoff 5m → 15m; a slow-but-200 refresh stamps
  the same window and skips further network until it expires.
- Usage-Monitor budget: while the lane is slow, `getBudgetStatusCached` returns
  stale cache or fail-open `null` and does not await UM (strategy runs do not
  pick up a 7s stall).
- Usage-Monitor push: flush delay is multiplied by the same p50 factor (2s → 8s
  on the 6.9s prod shape).
- Congress.Trade HTTP: transport/abort errors are `soft`; when p50 is already
  slow the client fails fast with `AbortError` and does not start an 8s wait.
- Congress.Trade SSE: 8s connect timeout; backoff resets only after a connection
  lives 30s; five flaps in 10 minutes jump to a 5-minute cap; flaps log
  `soft: true` so they cannot hard-STOP the lane or page.
- Alert Center: `provider_degraded` incidents key on `payload.service` when
  present so same-lane title variants collapse to one live row.

### Files

- `src/lib/peer-lane-backoff.ts` (new)
- `src/lib/usage-monitor-knobs.ts`
- `src/lib/usage-budget.ts`
- `src/lib/usage-monitor-push.ts`
- `src/lib/api-clients/congress.ts`
- `src/lib/congress-stream.ts`
- `app/console/components/alert-center.tsx`
- `test/peer-lane-backoff.test.ts` (new)
- `test/usage-monitor-knobs-backoff.test.ts`
- `test/usage-budget.test.ts`
- `test/usage-monitor-push.test.ts`
- `test/api-clients-congress.test.ts`
- `test/congress-stream.test.ts`
- `test/alert-center-incident-grouping.test.ts`
- `test/setup-peer-lane-cleanup.ts` (new; vitest `setupFiles` afterEach)
- `vitest.config.ts`
- `docs/usage-monitor-integration.md`
- `docs/congress-trade-consume.md`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- No CT/UM server changes.  ST only changes how it consumes those lanes.
- First call after a quiet 15-minute window still pays the real timeout once so
  the lane can recover.  Subsequent calls in the window skip.
- SSE flaps are always soft.  A genuine subscription 401 still logs, but it
  does not page after five reconnects.
- Alert grouping still falls back to title when `payload.service` is absent so
  RAG / LLM / tier-downgrade producers do not collapse into one row.
- Peer-lane samples live on `globalThis` and vitest uses `maxWorkers: 1`, so a
  slow-lane fixture leaked into later files (history, UM flush, health).  The
  cleanup setup file only imports `peer-lane-backoff` (no DB) and resets after
  every test.

## Verification State

- Focused vitest on the #2550 files plus history / usage-compliance / connection-health
  after the setupFiles reset.
- `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` (recorded in the PR).
- This cloud VM injects provider keys (Massive alt, ROIC, Tiingo, Pushover, SiliconFlow,
  …).  Those are not part of this change; the suite is run with those names unset so
  tests that assume a keyless process match CI.

## Next Steps & Blockers

- After deploy: Connections `usage-monitor` call rate should drop while UM p50
  stays multi-second; `congress.trade:sse` flaps should stay yellow/soft and
  not bury Attention.
- CT/UM host contention is still an ops problem on those apps, not this PR.

## Zero-Code Findings

The 478/hr UM figure matched live flush cadence (2s debounce + ~7s POST), not
the knobs 1h TTL.  Knob negative-cache only fired on hard failure, so a slow
200 never widened anything.  SSE reset backoff on HTTP 200 before the stream
proved it could stay up, which is why flaps stormed.
