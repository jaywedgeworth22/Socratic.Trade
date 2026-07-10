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

## Review-fix round (2026-07-09, PR #1229 — 5 confirmed P2 findings)

Code review on PR #1229 confirmed five real P2 gaps in the registration/teardown interplay; all
fixed in one commit on this branch. Findings 1/2/4 were resolved as ONE coherent design change to
the auto-registration guard rather than three patches:

1. **Stale order list after the disabled-teardown** — `runSyntheticStopMonitor` fetches
   `getEquityOrders` BEFORE `reconcileBrokerProtectiveStops` runs, so on the teardown tick the
   just-cancelled broker stop still looked live and suppressed synthetic auto-registration: the
   position carried NEITHER protection for one tick. `ReconcileResult` now returns
   `cancelledOrderIds` (every successful `cancelEquityOrder`), and the monitor prunes those ids
   from the order list REGISTRATION coverage uses. The fire and confirmed-dead paths deliberately
   keep the unpruned list — a cancel the broker merely accepted can still fill, and there a stale
   skip costs one tick while a wrong fire costs a duplicate market sell.
2. **Quantity-blind symbol-level stop guard** — `brokerStopSymbols.has(sym)` short-circuited before
   the quantity-aware `liveExitOrderCoverage` check, so a live broker stop covering 40 of 100
   shares suppressed synthetic protection for the other 60 forever. The symbol shortcut (and
   `isLiveBrokerStop`) is REMOVED; coverage governs registration alone. A full-size broker stop
   still fully suppresses (it is a live exit-side order and counts toward coverage), and the fire
   path already sells only the uncovered remainder.
3. **`pending_cancel` row overwritten by re-placement** — section 4 of
   `reconcileBrokerProtectiveStops` excluded `pending_cancel` rows from `existing`, so a failed
   cancel followed by a placement upserted a new `broker_order_id` over the row (UNIQUE
   user/account/symbol), orphaning the old still-live GTC stop untracked. A `pending_cancel` row
   now BLOCKS placement for its symbol until the section-1 retry lands the cancel.
4. **Side-blind stop guard** (pre-existing, same fix as 2) — `isLiveBrokerStop` never checked order
   side, so a live stop-BUY add-on marked a long's symbol broker-protected. Coverage
   (`isLiveExitOrder`) is side-aware, so dropping the shortcut fixes this too.
5. **`LIVE_ORDER_STATES` drifted from `ACTIVE_BROKER_ORDER_STATES`** — `broker-side.ts` omitted
   `submitted`/`pending_cancel`/`pending_replace`/`suspended`, which `broker-held-orders.ts`
   classifies as active; a pending-cancel exit can still fill yet stopped counting as coverage.
   Added the four states, exported `ACTIVE_BROKER_ORDER_STATES`, and added a superset test so the
   two vocabularies cannot silently drift again.

Files: `src/lib/synthetic-stops.ts`, `src/lib/broker-protective-stops.ts`, `src/lib/broker-side.ts`,
`src/lib/broker-held-orders.ts` (export only), `test/synthetic-stops.test.ts` (4 new regressions:
full-size stop via coverage, partial-size stop fires the remainder, stop-BUY not protection,
teardown-tick registration; mock gains `cancelEquityOrder`), `test/broker-protective-stops.test.ts`
(pending_cancel blocks re-placement + recovery), `test/broker-side.test.ts` (new states + superset
drift guard), this note.

Verification (review-fix round): `npx tsc --noEmit` clean; targeted suites green —
`npx vitest run test/synthetic-stops.test.ts test/broker-protective-stops.test.ts
test/broker-side.test.ts test/broker-held-orders.test.ts` (60 tests) plus the four other suites
importing the touched modules (31 tests); `npx eslint` on touched files: 0 errors (2 pre-existing
warnings). Full `npm test`/`npm run build` left to the `verify` CI gate on the PR.

## Follow-ups / still-open blockers
- **Blocker #1 (RH MCP stop-market/GTC contract unverified live) is NOT closed by this PR.** The
  remaining gate before `robinhoodBrokerStops` can default ON is a single live RH smoke test
  confirming `place_equity_order` actually RESTS a `stop_market` GTC (returns a trackable resting
  order id) and `get_equity_orders` reports it in one of the now-recognized live states
  (`queued/confirmed/unconfirmed`). Only after that should the default flip.
- Pre-existing deferred items from `docs/rollouts/2026-06-23-rh-stops-price-triggers-spy-bench.md`
  remain: verify the RH MCP stop-order type string against a live account; take-profit + partial-fill
  handling for RH stops.
