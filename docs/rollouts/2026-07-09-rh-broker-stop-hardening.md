# 2026-07-09 — Robinhood broker-held resting-stop hardening (2 safety bugs; still DEFAULT OFF)

## Summary
Safety hardening for the opt-in Robinhood broker-held protective-stop feature
(`policy.robinhoodBrokerStops`, shipped in `docs/rollouts/2026-06-23-rh-stops-price-triggers-spy-bench.md`).
Verification of that feature found two code-level hazards that would bite once the owner enables it.
Both are now fixed. **The default stays OFF** (`defaults.ts` `robinhoodBrokerStops: false` untouched);
this PR is hardening, not enablement.

Failure modes here were "orphan / extra stop", never "no protection" — the always-on synthetic-stop
monitor remains the fallback.

### Gap 1 — RH resting-order states unrecognized → double-exit risk (FIXED)
`synthetic-stops.ts` classified a broker order as still-resting via an Alpaca-flavored state set
(`new/accepted/pending_new/held/partially_filled/…`). Robinhood's `get_equity_orders` reports a
working/resting order as `queued` / `confirmed` / `unconfirmed`, none of which were in that set. So a
resting RH broker stop was INVISIBLE to `isLiveBrokerStop`. Consequence: with BOTH
`riskRules.trailingStopPct > 0` and `robinhoodBrokerStops` on, the synthetic monitor didn't see the
broker stop, auto-registered its own synthetic trailing stop for the same symbol, and could
market-sell on top of the resting broker stop — a double exit / unintended liquidation.

**Fix (additive, at the broker-agnostic layer):** added `isLiveOrderState(state)` to `broker-side.ts`
as the companion to the existing `isRejectedOrCanceledState`. It recognizes both Alpaca resting
states AND Robinhood's `queued/confirmed/unconfirmed`. `synthetic-stops.ts` `isLiveBrokerStop` now
calls it instead of a local Alpaca-only set. The two broker vocabularies are disjoint (Alpaca never
emits `queued/confirmed/unconfirmed`), so recognizing RH's states can never reclassify an Alpaca
order. Net: a resting RH stop now counts toward `isLiveBrokerStop`, so the monitor treats the symbol
as already-protected and does NOT place a duplicate exit.

### Gap 2 — disabling the flag stranded resting stops → orphan risk (FIXED)
`reconcileBrokerProtectiveStops` early-returned when `brokerProtectiveStopsEnabled` was false — and it
is the ONLY cancel-on-close/reconcile path. So turning `robinhoodBrokerStops` OFF while stops rested
left live GTC broker stops resting forever with no app-side cleanup.

**Fix:** the flag now gates only PLACEMENT of new stops, not CANCELLATION. When the feature is
disabled (or no longer live/Robinhood/stop-loss) but `broker_protective_stops` rows still exist for
the account, reconcile runs a teardown: cancel each resting broker stop (`gateway.cancelEquityOrder`)
and delete its row (`deleteBrokerProtectiveStop`), with the same `pending_cancel` retry on a failed
cancel that the enabled path uses. Teardown is pure risk-reduction (it never places a replacement),
so the `liveReplaceBlocked` "never leave a position unprotected" guard — which only matters when
cancelling WITH intent to re-place — deliberately does not apply. If no rows exist it is a true no-op
(the common default-OFF case).

Also fixed a latent supporting bug: `listBrokerProtectiveStops` filtered to `status = 'resting'`,
which hid `pending_cancel` rows from the reconcile retry pass — so a failed cancel could never be
retried and would orphan regardless of feature state. It now returns
`status IN ('resting','pending_cancel')`; rows are hard-deleted on a successful cancel, so those are
the only two persisted statuses. Callers that need resting-only rows (mismatch replacement) still
check `status === 'resting'` themselves; the enabled path's place-if-missing already excludes
`pending_cancel`.

## Why
This is exit-path code on a real-money account. The two gaps are both silent-until-enabled: neither
shows up until the owner flips `robinhoodBrokerStops` on. Closing them now makes the feature safe to
enable after a live smoke test, without changing any default behavior today.

## Files
- `src/lib/broker-side.ts` — NEW `isLiveOrderState()` (broker-agnostic resting/live check; RH +
  Alpaca vocabularies).
- `src/lib/synthetic-stops.ts` — `isLiveBrokerStop` consumes `isLiveOrderState` (dropped local
  Alpaca-only `LIVE_ORDER_STATES`); import + doc comment.
- `src/lib/broker-protective-stops.ts` — cancel-on-disable teardown branch replacing the early
  return; module header doc updated.
- `src/lib/db-api-keys.ts` — `listBrokerProtectiveStops` now returns `resting` + `pending_cancel`.
- `test/broker-side.test.ts` — `isLiveOrderState` unit tests (RH resting states live; terminal not;
  complementary to the decline check).
- `test/synthetic-stops.test.ts` — resting RH stop (`queued/confirmed/unconfirmed`) suppresses the
  duplicate synthetic exit (`it.each`).
- `test/broker-protective-stops.test.ts` — cancel-on-disable teardown + `pending_cancel` retry on a
  failed cancel; `fakeGateway` gains a `failCancel` toggle. All 7 pre-existing cases still green.
- `docs/rollouts/2026-07-09-rh-broker-stop-hardening.md` (this note); `STATUS.md`; effort logs.

## Verification
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (grandfathered warnings only).
- `npm test` — 267 files / 2672 tests pass (targeted trio: broker-protective-stops +
  synthetic-stops + broker-side = 36 pass).
- `npm run build` — green.
- **Landing-session re-verification (2026-07-09, dedicated worktree `trading-monet-rh-harden`,
  fresh `npm ci`, on top of current `main`):** `npx tsc --noEmit` clean; `npm run lint` 0 errors;
  `npm test` — 306 files / 3181 tests pass (full suite grew since the original build session, no
  targeted-only run needed this time); `npm run build` succeeded. No mechanical fixes or
  test-expectation changes were required — the staged diff was inspected against this note's
  description and matches it exactly.

## Follow-ups / still-open blockers
- **Blocker #1 (RH MCP stop-market/GTC contract unverified live) is NOT closed by this PR.** The
  remaining gate before `robinhoodBrokerStops` can default ON is a single live RH smoke test
  confirming `place_equity_order` actually RESTS a `stop_market` GTC (returns a trackable resting
  order id) and `get_equity_orders` reports it in one of the now-recognized live states
  (`queued/confirmed/unconfirmed`). Only after that should the default flip.
- Pre-existing deferred items from `docs/rollouts/2026-06-23-rh-stops-price-triggers-spy-bench.md`
  remain: verify the RH MCP stop-order type string against a live account; take-profit + partial-fill
  handling for RH stops.
