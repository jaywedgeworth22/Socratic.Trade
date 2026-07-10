# 2026-07-10 — Broker-held trailing stops (Alpaca native + Robinhood ratcheted) + Guardrails stop consolidation

Agent: CLAUDE (cloud session, branch `claude/stop-loss-preset-options-f1jygn`)

## Summary

Owner-directed, three asks in one session:

1. **Trailing stops are now broker-held on both brokers** (owner: "ensure that robinhood and
   alpaca have trailing stop loss working since they both have that feature now").
   - **Alpaca (paper + live):** TRUE native `trailing_stop` orders. New
     `EquityOrderInput.trailPercent`; the Alpaca gateway translates it to
     `type: "trailing_stop"` + `trail_percent`, drops any `stopPrice` (Alpaca rejects price
     params on trailing stops), requires whole shares, and refuses trailing+bracket combos.
     The MCP lane is bypassed for trailing (REST direct) — no guessing at unverified MCP arg
     schemas.
   - **Robinhood (live only):** the RH MCP exposes **no verified native trailing parameter**, so
     rather than silently sending unverified args, the protective-stop reconciler emulates the
     trail with verified primitives: a resting GTC `stop_market` at `trailingStopPct` below the
     high-water mark, RATCHETED upward (cancel-replace) each scheduler tick as price rises
     (churn-guarded: replaces only on a ≥ $0.02 and ≥ 0.1% move; never ratchets down). Between
     ticks the broker holds a real stop, so protection survives app downtime. `toMcpOrder` now
     throws on `trailPercent` (fail closed, like short/cover) with a pointer to the ratchet lane.
     Gated on the existing `robinhoodBrokerStops` opt-in (the "resting stops at RH are
     live-verified" switch) — one flag continues to govern all RH resting stops.
   - New policy flag **`brokerTrailingStops` (default ON, inert until
     `riskRules.trailingStopPct` > 0** — which still defaults to 0/off). Off-switch per the
     "preferences, not cages" philosophy. Validated in the policy route.
   - `broker_protective_stops` table: new `kind` (`fixed`|`trailing`) + `trail_percent` columns
     (migration 16; pre-existing rows are RH fixed stops → `'fixed'` default is correct).
     Kind changes are detected as mismatches (cancel-then-replace, still guarded by
     `liveReplaceBlocked` so a position is never left stopless).
   - **Placement is now coverage-aware:** the synthetic monitor passes its pre-reconcile order
     list into `reconcileBrokerProtectiveStops`, which skips a position already fully covered by
     another live exit-side order (an Alpaca OCO bracket stop leg, a manual GTC sell) instead of
     provoking a broker rejection every tick. Orders cancelled by the same reconcile are pruned
     from the coverage source first. `isLiveExitOrder`/`liveExitOrderCoverage` moved from
     `synthetic-stops.ts` to `broker-side.ts` (shared, no import cycle; semantics unchanged).
   - Long positions only (Robinhood is long-only; Alpaca shorts keep synthetic trailing coverage —
     broker-held short trails are an explicit follow-up).

2. **Guardrails UI: stop settings consolidated** (owner: "the standard stop loss % shouldn't be
   alone and separate from the other related settings that are down lower in advanced settings").
   The lone Essentials "Stop-loss" row (whose hint was actively misleading — with ATR stops ON by
   default, the flat % is only the FALLBACK distance) plus take-profit/trim and the buried
   "Protective stops plumbing" advanced group are now ONE **"Protective stops" card** between
   Essentials and the Advanced rulebook, containing every per-position exit rule with rewritten
   fallback-honest hints, plus the new `brokerTrailingStops` toggle.

3. **Stop-flow diagram** (owner: "arranged on the screen with some graphical depiction/flow or
   arrows between them so that the user can easily tell which works when one fails or isn't
   available… and how trailing stop losses will fit into that").
   New `app/console/guardrails/stop-flow.tsx`: three lanes with labeled fallback arrows, computed
   live from the account's policy (active nodes lit, inactive dimmed, current values shown):
   - **Distance:** ATR stop —(no price history)→ Beta-scaled —(no beta)→ Flat base %.
   - **Trailing:** the high-water-mark overlay that runs alongside the distance stop.
   - **Enforcement:** Broker-held (brackets / native trailing / RH resting) —(broker can't hold
     it)→ App monitor (every tick; pauses while Stopped).
   The model is a pure exported function (`stopFlowModel`) so the wiring is unit-tested.

## Why

The owner reviewed both brokers as supporting trailing stops and asked that the app actually use
them; and correctly observed that the settings UI presented stop mechanisms as unrelated scattered
options with no depiction of the fallback chain, while defaults (ATR+beta ON since 2026-07-07)
made the "Stop-loss %" hint literally untrue. The RH native-vs-ratchet decision: sending
unverified `trailing_peg`-style args to the RH MCP could silently degrade into a never-moving
stop (dishonest trail) — the ratchet gets a REAL working trail out of verified primitives, and if
RH's MCP later exposes a native param, `toMcpOrder` is the single place to translate it.

## Decisions made

- `brokerTrailingStops` defaults ON because it is inert until the owner deliberately sets a
  trailing % (default 0), safe on Alpaca (documented REST feature), and RH additionally requires
  the `robinhoodBrokerStops` opt-in. No behavior change for any existing configuration.
- Trailing takes precedence over the RH fixed stop when both lanes apply — shares can only back
  one resting sell; the synthetic monitor still layers the other rule on its tick.
- Alpaca positions opened with brackets (default) keep their bracket stop leg; the coverage check
  means the trailing lane doesn't fight it. Native trailing applies to positions without live
  exit-order coverage (manual buys, bracket-less entries, brackets off).
- Per-position LLM-chosen stop plans (owner ask #4) deliberately NOT ridden along — planned with a
  design sketch in `docs/EFFORT-LOG.md` (money-path change across ~6 modules + a migration).

## Files

- `src/lib/types.ts` — `EquityOrderInput.trailPercent`, `TradingPolicy.brokerTrailingStops`.
- `src/lib/defaults.ts` — `brokerTrailingStops: true`.
- `src/lib/alpaca.ts` — native trailing_stop translation in `placeEquityOrder`.
- `src/lib/robinhood.ts` — `toMcpOrder` fails closed on `trailPercent`.
- `src/lib/broker-protective-stops.ts` — two-lane reconciler (`brokerTrailingStopsEnabled`,
  `desiredBrokerStopKind`, kind-aware mismatch incl. ratchet, coverage-aware placement).
- `src/lib/broker-side.ts` — `isLiveExitOrder` + `liveExitOrderCoverage` moved in (shared).
- `src/lib/synthetic-stops.ts` — imports moved helpers; passes `brokerOrders` to reconcile.
- `src/lib/db.ts` — migration 16 + CREATE TABLE columns (`kind`, `trail_percent`).
- `src/lib/db-api-keys.ts` — `BrokerProtectiveStop.kind`/`trailPercent` mapping + upsert.
- `app/api/policy/route.ts` — `brokerTrailingStops` boolean validation.
- `app/console/guardrails/field-defs.ts` — `PROTECTIVE_STOPS` group (replaces `STOPS_PLUMBING`;
  absorbs stop-loss/take-profit/trim from `ESSENTIALS`), honest fallback hints.
- `app/console/guardrails/stop-flow.tsx` — NEW: `stopFlowModel` + `StopFlowDiagram`.
- `app/console/guardrails/page.tsx` — new "Protective stops" card; advanced group removed.
- `test/broker-protective-stops.test.ts` — trailing-lane suite (enablement, native vs ratchet,
  ratchet up/never down, kind switch, coverage skip, teardown, fractional flooring).
- `test/alpaca-brackets.test.ts` — trailing translation + bracket/notional rejection.
- `test/broker-side.test.ts` — `toMcpOrder` trailPercent throw.
- `test/stop-flow-model.test.ts` — NEW: diagram model truthfulness.
- `test/console-policy-diff.test.ts` — import rename.
- `docs/stop-loss-and-exit-strategies.md`, `STATUS.md`, `docs/EFFORT-LOG.md` — updated.

## Verification

Run in the cloud container (Node 22):

```bash
npx vitest run test/broker-protective-stops.test.ts test/alpaca-brackets.test.ts \
  test/broker-side.test.ts test/synthetic-stops.test.ts test/stop-flow-model.test.ts \
  test/console-policy-diff.test.ts test/settings-search-index.test.ts   # 112/112 pass
npm run lint        # (full-gate results recorded below before push)
npx tsc --noEmit
npm test
npm run build
```

## Review fixes (Codex, PR #1331 — all six findings valid, fixed in the follow-up commit)

1. **Stop-loss hint honesty:** clearing the field reverts to the shipped 8% default (mergePolicy
   refills it), it does NOT disable stops — hint rewritten.
2. **Already-breached trails:** placement now skips (and does not advertise) a trailing stop whose
   entry-seeded trigger is at/above the current mark — a native order would restart the trail from
   the depressed market and defer the exit by a full trail distance; the synthetic monitor
   registers and fires the app-defined exit instead.
3. **Fractional remainders:** partial placements (floored native trailing, partially-covered
   positions) are advertised via a new `partiallyPlacedStopSymbols` — the synthetic monitor defers
   only the FIRE path for them and still REGISTERS, so the remainder is never stop-less for a tick.
4. **alpaca-mcp transport:** native trailing is REST-only; `alpaca-mcp` accounts (possibly
   endpoint-only) now take the ratcheted stop_market lane through their own MCP transport.
5. **Partial coverage sizing:** broker stops are sized to the UNCOVERED remainder
   (`uncoveredQuantity`, own-order excluded in mismatch checks) — never stacking more exit
   quantity than the account holds.
6. **Diagram cadence honesty:** the app-managed enforcement node now says fixed/ATR breaches exit
   on each STRATEGY RUN while only the trailing monitor evaluates every scheduler tick.

## Follow-ups / risks

- **Live-verify the RH ratchet lane before enabling `robinhoodBrokerStops`** — same standing
  caveat as the fixed lane (that flag remains default OFF).
- Broker-held trailing for Alpaca SHORT positions (buy-side trailing stop) — follow-up.
- Alpaca order-list mapping reports a resting trailing_stop as `stop_market` (`mapAlpacaOrderType`)
  — deliberate (coverage counts it as protection); revisit if the UI should label it "trailing".
- Per-position LLM stop plans: Planned row + design sketch in `docs/EFFORT-LOG.md`.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board) could NOT be updated from
  this cloud session (no Mac filesystem access) — next Mac-side agent should sync the mirror.
