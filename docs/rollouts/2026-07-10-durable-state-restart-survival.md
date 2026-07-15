# 2026-07-10 — Durable state: make in-memory rate-limiters/cooldowns survive a restart

## Summary

Auto-deploy went live fleet-wide today (every merge to `main` now redeploys `socratic-trade-prod`
immediately, replacing the running container mid-session). This surfaced a real gap: several
in-memory rate-limiter/circuit-breaker/cooldown Maps existed specifically to bound a real external
cap or prevent a real duplicate financial action, but reset to empty on every process restart —
silently re-granting a budget/cooldown a redeploy has no business handing out.

Per owner directive ("persist all variables/counts... have that be the standard... for all things"),
built ONE shared write-behind SQLite-backed persistence primitive (`createDurableMap`, in
`src/lib/durable-state.ts`) and used it to make every genuinely-at-risk in-memory guard survive a
restart, after a full-codebase discovery sweep to find them all.

## Discovery (multi-modal sweep, 32 candidate sites)

A 4-way parallel workflow swept: (1) the already-known provider-rate-limit/AV-key-pool/circuit-
breaker family, (2) scheduler/notifications/congress-share/order-replacement/synthetic-stops, (3)
LLM/red-team/model-rotation, (4) a broad grep for module-level `Map`/counter patterns app-wide.
Verified two of its conclusions directly rather than trusting them blind: `twelveDataWindowStartByCred`
(flagged as still-existing dead code) had actually already been removed by the earlier unified-quota
PR; and `congress-share.ts`'s `refSentAt` got contradictory verdicts from two sweep agents — read the
actual code/comments and confirmed it's genuinely idempotent-safe (low priority, not high-risk).

**Persisted (real consequence if reset):**
- `provider-rate-limit.ts`'s `RequestQuota.hits` — tracks REAL server-side rate caps (twelvedata
  8/min+800/day, tiingo 50/hour+1000/day). A restart re-granting a burned budget risks real 429s/
  throttling. *(This was the one already flagged before this sweep — see the 2026-07-10 unified-quota
  rollout note.)*
- `order-replacement.ts`'s `recentlyRemediatedExits` — the 5-minute double-sell guard on stale-exit
  auto-remediation. A restart inside the cooldown window could let the very next scheduler tick
  cancel-replace the SAME order twice before the broker's eventually-consistent order feed catches
  up — a real double-sell/accidental-short risk (`flush: "immediate"`, since losing the last write
  to an ungraceful crash defeats the guard's whole purpose).
- `triggers.ts`'s `UserTriggerState` durable fields (`lastRunMs`/`hourStartMs`/`hourCount`/
  `dayStartMs`/`dayCount`/`perSymbolMs`/`dedup`) — the event-driven LLM-trigger engine's hourly/daily
  run caps and per-event dedup (gated behind `TRIGGER_ENGINE`, default off). A restart silently
  resets the caps that exist to bound LLM spend/order frequency, and forgets which webhook events
  were already processed. NOT persisted: `buffer`/`firstEventMs`/`timer` — live in-flight batching
  state with nothing meaningful to resume after a restart (`timer` is a raw `NodeJS.Timeout` handle
  that can't be serialized at all).
- `usage-budget.ts`'s `alertSentAt` — was the ONE alert-cooldown in the codebase using a bare
  in-memory Map while every sibling (`db-health.ts`, `usage-limit-alerts.ts`,
  `broker-minimum-guard.ts`, `vector-db.ts`) already persists via `getInternalSetting`/
  `setInternalSetting`. An inconsistency, not a deliberate choice — fixed to match.
- `congress-share.ts`'s `refSentAt` — the per-symbol 6h send throttle. Low priority (App A's import
  endpoint is idempotent — worst case of losing this is redundant, harmless network calls), persisted
  anyway for completeness now that the primitive exists (`debounced` flush; no financial/safety risk
  either way).

**Deliberately left as bare in-memory `Map`/`Set` (confirmed correct, not persisted):**
- `ProviderRateLimiter`'s pacer state (`provider-rate-limit.ts`) — in-process burst/concurrency
  pacing; a fresh process correctly starting at 0 in-flight IS the right post-restart state.
- Alpha Vantage key-pool's sticky `currentIndex` rotation pointer — the `exhaustedUntil` half (the
  part that actually matters) is ALREADY durable via `getInternalSetting`; only the round-robin
  starting point resets, which is harmless.
- `api-circuit-breaker.ts`'s `trippedUntil` — a thin in-process cache in front of the durable
  `api_health_log` table; the very next call re-derives real lane health from that table regardless.
- In-flight locks/dedup Sets tied to live async operations (`scheduler.ts`'s
  `stopMonitorInFlight`/`staleExitInFlight`, `order-replacement.ts`'s `inFlightMarketReplaces`,
  `data-providers.ts`'s `secXbrlInFlight`, `vector-db.ts`'s `indexInitPromises`) — persisting these
  would resurrect stale locks that can never be released, the opposite of correct.
- `congress-trade-events.ts`'s `seenIds`, `rate-limit.ts`'s HTTP-request buckets,
  `usage-monitor-push.ts`'s call-volume telemetry — dedup/rate-limit windows whose correct
  post-restart state is empty, or pure metrics with no external cap behind them.
- `model-rotation.ts` — already durable via `getInternalSetting`/`setInternalSetting`; checked
  directly since its name was the most obvious candidate, confirmed no gap.

## The primitive (`src/lib/durable-state.ts`)

`createDurableMap<T>(namespace, { flush })` — a `Map`-shaped drop-in (`get`/`set`/`delete`/`has`/
`clear`/`entries`/`keys`/`size`) backed by a new generic `durable_state(namespace, key, value,
updated_at)` SQLite table (CRUD in `src/lib/db-durable-state.ts`, migration in `db.ts`).

- **Hydrate once per namespace** on first touch (reads all rows for that namespace into an
  in-memory cache — the source of truth for reads thereafter).
- **`"debounced"` flush (default)**: writes batch and flush ~15s after the last write, or on
  `SIGTERM`/`SIGINT`/`beforeExit`. Right for anything checked/updated frequently — no per-call DB
  latency on the hot path.
- **`"immediate"` flush**: synchronous write-through on every `set`/`delete`. Right for low-frequency
  call sites where losing the last write to an ungraceful crash matters more than the write cost
  (used for the order-remediation double-sell guard).
- All module state (cache, hydration flags, pending writes, the shutdown-hook-registered flag) is
  **globalThis-pinned**, mirroring the pattern already used by `order-replacement.ts`/
  `congress-share.ts`/`triggers.ts`/`scheduler.ts` — needed so Next.js HMR (dev) and vitest's
  per-test-file module isolation don't spawn duplicate `process.once("SIGTERM", ...)` registrations
  (caught via a `MaxListenersExceededWarning` during test development — fixed before landing).

`RequestQuota` (provider-rate-limit.ts) stays a pure, DB-agnostic, unit-testable class (unchanged
constructor/API); the module-level singleton (`admitProviderRequests`/`refundProviderRequests`/
`resetProviderQuotaState`) owns hydration/persistence via `getLane`/`restoreLane` snapshot methods,
gated on `durable-state.ts`'s own `hasHydratedNamespace()` (not a second, parallel flag) so a test's
`resetDurableStateCacheForTests()` is the single source of truth for "forget everything and
re-hydrate," matching every other call site.

## Files

- New: `src/lib/durable-state.ts`, `src/lib/db-durable-state.ts`, `test/durable-state.test.ts`.
- `src/lib/db.ts` — `durable_state` table in `migrate()`; barrel re-export.
- `src/lib/provider-rate-limit.ts` — `RequestQuota.getLane`/`restoreLane`; module-level hydrate/
  persist wiring; `simulateProviderQuotaRestartForTests()` test seam.
- `src/lib/order-replacement.ts`, `src/lib/congress-share.ts`, `src/lib/usage-budget.ts`,
  `src/lib/triggers.ts` — swapped the relevant bare `Map` for `createDurableMap`.
- `src/lib/triggers.ts` — added `resetTriggerStateForTests()` test seam.
- Tests: `test/durable-state.test.ts` (14, primitive-level: Map API, restart survival, flush modes,
  clear, namespace isolation, corrupt-row handling) + restart-survival tests added to
  `test/provider-rate-limit.test.ts`, `test/order-replacement.test.ts`, `test/congress-share.test.ts`,
  `test/usage-budget.test.ts`, `test/triggers.test.ts`.

## Verification

Node ABI trap still applies (see `docs/rollouts/2026-07-10-unified-provider-quota.md`) — every gate
run under `/opt/homebrew/opt/node@24/bin`:

- `npm run lint` → 0 errors (377 grandfathered warnings)
- `npx tsc --noEmit` → clean
- `npx vitest run` (--maxWorkers=4) → <fill: result>
- `npm run build` → <fill: result>

## Follow-ups

- None known. The scope was deliberately bounded to guards with a real external-cap or real
  duplicate-action consequence; deliberately-ephemeral state was left alone per the discovery
  sweep's per-site reasoning above.
</content>
</invoke>
