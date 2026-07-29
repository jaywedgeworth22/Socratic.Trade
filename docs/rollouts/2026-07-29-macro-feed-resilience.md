# 2026-07-29 — Macro Feed Resilience + Unknown-Side Regime-Flip Suppression (KIMI)

## 1. Context & Objective

Production evidence (2026-07-28, verified by parent): the prod `regime_flip` audit log flapped
"Neutral (Normal Volatility)" <-> "Unknown (no macro feed)" — six transitions on 2026-07-28 alone,
some ~1 minute apart — churning the stored current-regime label and risking LLM trigger runs on
recovery into an escalation regime (745 `trigger_run` audit events in 7 days). Two owner-directed
changes: (1) make the keyless macro/VIX read resilient now that the paid FMP key is suspended, and
(2) stop treating a data outage as a regime change.

**Zero-code finding that reframed change 1:** the macro chain (`fetchMacroData` / live-VIX overlay
in `src/lib/macro.ts`) never called FMP. It is FRED (keyed) + a single keyless Yahoo `^VIX` lane.
The suspended FMP key only affected the *enrichment* cascade (already handled by the 2026-07-28
data-cascade fix). The regime flap's real driver on the macro side was the SINGLE keyless VIX lane:
any transient Yahoo rate-limit/bot-challenge dropped the read to `asOf: "unavailable"`, and the
flip detector announced that as a regime change. `fmpMacroDataEnabled` / `fmpRealTimeDataEnabled`
are dormant policy flags (referenced only in `types.ts` / `defaults.ts` / `db-profiles.ts`);
`fmp-beta.ts`'s `getMacroContext()` / `getFullMacroPicture()` have no callers in the macro chain.
So instead of "routing around FMP" we widened the keyless VIX chain and added cooldowns — FMP was
deliberately NOT added as a VIX tier (a suspended paid key must not be hammered every tick).

## 2. Changes Made

**Change 1 — keyless VIX cascade with shared circuit-breaker cooldowns (`src/lib/macro.ts`):**
- `fetchVixFromYahoo` generalized into `fetchVixLane(lane, url, accept, parse)` + a three-source
  cascade `fetchKeylessVix()`, consumed by both `fetchVixOnlyFallback` (24h path) and
  `fetchLiveVix` (10-min live overlay). Lane order (first success wins):
  1. **Yahoo `^VIX` chart** (`vix-yahoo`) — the proven lane this module has always used.
  2. **Cboe `_VIX` delayed quote** (`vix-cboe`) — the authoritative VIX publisher's own keyless CDN,
     same host family already trusted for `_SKEW`/`_VVIX` in `market-signals/cboe.ts`.
  3. **Stooq `^vix` CSV quote** (`vix-stooq`) — independent aggregator, different failure domain.
- Each lane consults `apiCircuitBreakerShouldSkip(lane, null)` before fetching and records
  success/failure via `logApiHealth` (keyless = NULL keySource lane), reusing the repo's existing
  dead-lane short-circuit: a lane whose recent history reads "stopped working" (getLaneHealth
  predicate) trips for `API_CIRCUIT_BREAKER_BACKOFF_MS` (default 60s), then one half-open probe.
  A dead endpoint is probed on a 60s cadence, not hammered every scheduler tick; sibling lanes
  keep serving while one cools down.
- Honesty preserved: ALL sources dead -> null -> the existing honest `asOf: "unavailable"` path.
  Nothing is fabricated; change 2 makes that state graceful.
- FRED suite untouched (still used when `FRED_API_KEY` resolves; NaN rates still tolerated by the
  classifier).

**Change 2 — Unknown-side regime-flip suppression (`src/lib/regime-watch.ts`):**
- When `determineMarketRegime` returns `MARKET_REGIME_LABELS.unknown` ("Unknown (no macro feed)"),
  `checkRegimeFlip` now early-returns: stored last-known label NOT overwritten, no `regime_flip`
  audit, no dashboard `dirty` event, no material event, no first-tick seeding with the Unknown label.
- New throttled diagnostic audit kind `macro_feed_unavailable`, at most once per hour per user
  (marker `regime:macro-unavailable-notified:{userId}` = last-emitted ISO timestamp in the internal
  KV). Payload carries `asOf`, `vixAsOf`, `heldRegime`, `throttleMinutes` — outage stays observable
  without flap spam.
- Recovery: the stored last-known label survives the outage, so the first recovered tick compares
  it against the recovered REAL label with the existing semantics (escalation -> material event +
  dirty + audit; de-escalation -> audit + dirty only).
- Repair path: a persisted Unknown label from a pre-gate deploy is treated as unseeded and silently
  replaced on the first known tick (no fake "Unknown -> X" flip).
- Legacy `regime:current` migration fallback preserved. `determineMarketRegime` /
  `entryMarketRegime` stamping untouched (honest label; change 1 makes Unknown rare).

**Files touched:**
- `src/lib/macro.ts`
- `src/lib/regime-watch.ts`
- `test/macro-live-vix.test.ts` (extended stubFetch to Cboe/Stooq; new cascade + breaker-cooldown
  describe; per-describe VIX-lane state reset)
- `test/regime-watch.test.ts` (new "Unknown-side outage suppression" describe, 5 tests)
- `test/cache-provenance.test.ts` (beforeEach now resets the VIX breaker + purges vix lane health
  rows — a previous test's stubbed failures would otherwise trip the lanes and skip sources)
- `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/rollouts/2026-07-29-macro-feed-resilience.md`

## 3. Decisions & Trade-offs

- **Breaker reuse via `apiCircuitBreakerShouldSkip` + `logApiHealth` directly, not `fetchWithRetry`.**
  `fetchWithRetry` (`data-providers.ts`) bundles quota reservations, usage telemetry, and guard
  fences the VIX lanes don't need, and importing the 6k-line `data-providers` closure (robinhood,
  quiver, news-store, ...) into `macro.ts` was unjustified weight. The reused machinery is identical:
  same per-(service, keySource) lane health in `api_health_log`, same 60s trip + half-open probe.
- **Lane order Yahoo -> Cboe -> Stooq** keeps the existing primary behavior byte-stable; Cboe is the
  authoritative publisher but its delayed quote is a coarser single number; Stooq is CSV and
  occasionally N/D. Order is about failure-domain diversity, not data quality ranking.
- **A 200-with-no-usable-value counts against lane health** — from this module's perspective the
  endpoint is not serving the reading, and the breaker should learn that.
- **Unknown-side early-return runs AFTER the legacy migration read** so the diagnostic payload can
  report the held label, and so a legacy `regime:current` value still migrates into the user key.
- **Stored-Unknown repair is a silent reseed.** Alternative (announce "Unknown -> X" once) was
  rejected: Unknown was never a real regime to flip FROM, and one more fake flip row is exactly the
  spam this change kills.
- **No FMP tier added.** Dormant `fmpMacroDataEnabled`/`fmpRealTimeDataEnabled` flags left as-is
  (out of scope; reviving them is a policy decision for the owner, and the FMP key is suspended).
- **Throttle marker stored in internal KV (not DB audit count)** — survives restarts, no schema
  change, mirrors the regime-label storage pattern already in this module.

## 4. Verification State

All four gates, in order, on branch `agent/kimi-lane` (base 6a66cb73):

```
npx tsc --noEmit    -> exit 0 (the known test/alternative-data.test.ts mockFetcher flake did not appear)
npm run lint        -> 0 errors (655 grandfathered warnings, unchanged)
npm test            -> 5387 passed / 5387 across 464 files, run in 4 alphabetical chunks:
                       files   1-120: 1489 passed
                       files 121-240: 1411 passed
                       files 241-360: 1328 passed
                       files 361-464: 1159 passed
npm run build       -> exit 0 (Compiled successfully, 36/36 static pages)
```

New/updated test coverage (12 new tests total):
- `test/macro-live-vix.test.ts`: +5 (Cboe fall-through, Stooq fall-through, Cboe-only timestamped
  snapshot, all-dead honest `unavailable`, breaker trips lanes so dead endpoints are probed not
  hammered). Existing overlay/fallback tests updated for lane-state isolation.
- `test/regime-watch.test.ts`: +5 (outage tick holds label with zero flip/dirty/event + one
  diagnostic; diagnostic throttled to 1/hour across repeated outage ticks; recovery announces
  exactly one flip from last-known + one material event on escalation; first-ever outage tick never
  seeds Unknown; legacy stored-Unknown repaired silently).
- `test/cache-provenance.test.ts`: 0 new, beforeEach hardened (12/12 pass).

## 5. Next Steps & Blockers

- **Prod verification requires SSH to the NEW Oracle host `141.148.182.224`** (hosting migrated off
  Hetzner `135.181.192.190` — the old box's SSH now times out; see AGENTS.md hosting section). After
  this lands and auto-deploys: confirm the `regime_flip` flap stops (no Unknown-side rows), confirm
  `macro_feed_unavailable` rows appear at most hourly during any real outage, and check
  `api_health_log` for `vix-yahoo`/`vix-cboe`/`vix-stooq` lane rows to see which source is serving.
- Land via parent/owner (`scripts/land.sh` + PR) — committed locally on `agent/kimi-lane` only, per
  instructions (no push).
- Optional follow-ups (punted): surfacing per-lane VIX source attribution on the console Macro
  board; revisiting the dormant `fmpMacroDataEnabled`/`fmpRealTimeDataEnabled` flags if the owner
  reinstates an FMP key; considering a longer breaker backoff for keyless lanes if 60s probes still
  look chatty in prod logs.
