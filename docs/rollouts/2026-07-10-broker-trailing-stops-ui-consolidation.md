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

## Review fixes round 2 + main merge (Codex on `fc72001`; merged `origin/main` incl. PR #1352/#1341)

- **Native trails below entry:** a native Alpaca trail placed while mark < entry seeds from the
  depressed market (avg 100 / mark 96 / 5%: trigger ~91.2 vs the app's entry-seeded 95) — the
  native lane now places only when mark ≥ entry; below it the synthetic monitor keeps the
  entry-seeded trail (the ratcheted lane is unaffected — its explicit trigger IS entry-seeded).
- **Trailing copy honesty:** shares committed to resting broker exits (Alpaca bracket legs) can't
  also back a trail — hint + diagram now say bracketed positions keep their bracket exits.
- **Live-placement preflight:** sections 3–4 now return early when `livePreflightBlocks` is true
  (ALLOW_LIVE_TRADING=false escape hatch) — the default-on trailing lane can no longer place a
  real broker order past an explicit live-trading opt-out; risk-reducing cancels still run.
- **Merge with main:** PR #1352's pending_cancel self-heal (`isDoneRestingState`, filled-recovery
  defer) landed on main touching the same reconciler — its `orders` param and this PR's
  `brokerOrders` were the same caller list, so they are UNIFIED as `orders` (recovery + coverage
  documented together); PR #1341's connectedAccountId audit threading kept on the merged sites.
  NOTE: main also flipped **auto-deploy ON** (b4c4f4b) — merging this PR auto-deploys production.

## Review fixes round 3 (Codex on `c36c3ab`, three findings)

1. **P2 — coverage-unknown ≠ coverage-free:** when the synthetic monitor's own `getEquityOrders`
   fetch fails, it was passing an EMPTY order list into `reconcileBrokerProtectiveStops`, which
   the reconciler read as "confirmed no coverage" — placing (or, worse, resizing/cancelling) a
   broker-held stop against a blind spot that might actually hide a full-size bracket leg. New
   `ordersListed?: boolean` param (default `true`, preserving old behavior for every caller that
   never had real coverage info to begin with) — the synthetic monitor now passes its own
   `brokerOrdersListed` flag. `uncoveredQuantity`/`desiredStopQuantity` return `null` ("truly
   unknown") instead of a number when `ordersListed` is `false`, and BOTH section 3 (mismatch/
   cancel) and section 4 (new placement) skip a symbol entirely on `null` rather than guess.
2. **P2 — stop-flow tooltip still wrong:** the NEW diagram's "Flat base %" node detail repeated
   the same "clearing turns it off" claim already fixed in field-defs.ts's hint — corrected to say
   blanking reverts to the 8% default; only an explicit 0 disables the stop.
3. **P1 — partial broker stops wiped on a remainder-only exit:** when a broker-held stop covers
   only PART of a position (e.g. a native Alpaca trail floored 10.6 sh to 10), the synthetic
   monitor fires for just the uncovered remainder — but then called `cancelBrokerProtectiveStop`
   UNCONDITIONALLY, tearing down the still-valid 10-share stop covering the rest of the position.
   Fixed: the cancel now runs only when the fire closes the WHOLE position (`qty >=
   positionQty - epsilon`); a partial fire leaves the broker-held stop resting undisturbed.

New tests: `test/broker-protective-stops.test.ts` (ordersListed skip on placement/mismatch,
recovery on the next successful fetch, default-true regression); `test/synthetic-stops.test.ts`
(partial fire preserves the broker-held stop). Full gate re-run green after these fixes.

## Review fixes round 4 (Codex on `40ebbc2`, four findings)

1. **P2 — OCO bracket legs double-counted as coverage:** `liveExitOrderCoverage` summed the
   quantities of ALL live exit orders for a symbol, but an Alpaca OCO bracket's stop-loss and
   take-profit legs are mutually exclusive exits for the SAME shares (filling one auto-cancels the
   other) — summing both counted a fully-bracketed position's protection as double its real size.
   Harmless when a position's bracket covers 100% of it (the "≥ position size" skip fires either
   way), but a genuinely half-bracketed position (e.g. two independent 50-share scale-in brackets
   vs. one 50-share bracket on a 100-share position) had its uncovered half silently hidden from
   every caller that sizes a NEW broker-held stop off this number. Fixed: `liveExitOrderCoverage`
   now pairs a stop-type leg with an unused limit-type leg at a matching remaining quantity (the
   OCO bracket signature) and counts the pair once; unpaired legs (a lone resting stop, a manual
   take-profit-only sell) still count independently. Moved the whole computation from a flat sum to
   stop/limit/other buckets with pairing logic in `src/lib/broker-side.ts`.
2. **P2 — a mismatched trailing stop was cancelled even when the replacement would be refused:**
   section 3's cancel-then-replace logic didn't check whether section 4's already-breached /
   looser-than-app-trail guard would actually let the replacement land — a trail%/quantity change
   while price sat below entry (or the tracked high) cancelled the old (still-protective) stop and
   then correctly refused to replace it, leaving the position with NO broker-held stop until
   conditions recovered. Fixed: extracted the placement-eligibility check into a shared
   `canArmTrailingNow` helper; section 3 now skips the cancel (keeps the existing stop) whenever
   section 4 would refuse the replacement.
3. **P1 — a broker-held trail could be seeded looser than the app's own already-armed trail:** the
   ratchet/native-placement logic recomputed the trailing anchor from `max(currentMark, entry)`
   only — but if price had rallied above entry and then pulled back, the SYNTHETIC monitor's own
   `extreme_price` (the true high-water mark) could be well above the current mark, meaning the
   app's real trigger was already tighter (higher) than anything reconstructed from just the
   current tick's data. Example: avg 100, synthetic-tracked extreme 130, mark 120, 5% trail — the
   app's real trigger is 123.50, but recomputing from `max(120,100)` would arm a broker trail
   around 114, weakening protection the moment broker-held trailing turns on. Fixed: new
   `extremePriceBySymbol` param (the synthetic monitor's own ACTIVE-row extremes, fetched by the
   caller before reconcile runs) feeds `trailingTriggerPrice` and the native-lane placement guard
   (now `mark >= max(entry, trackedExtreme)` instead of just `mark >= entry`), so a broker-held
   trail is never armed looser than the trail already protecting the position.
4. **P2 — the stop-flow diagram implied ATR/beta distance applies to Robinhood's fixed broker
   stop:** `reconcileBrokerProtectiveStops`'s fixed-kind price calc uses the flat `stopLossPct`
   only, never the ATR/beta-adjusted effective distance shown in the diagram's distance lane —
   properly closing that gap requires threading per-symbol effective-stop-distance data into
   `broker-protective-stops.ts` (this file has no market-scan/beta access today), which is the same
   plumbing the planned per-position stop-plan feature will add. For now, fixed with an honest
   annotation: the enforcement lane's "Broker-held" node explicitly calls out the exception when
   Robinhood's fixed lane is active. Proper fix deferred to the stop-plan follow-up.

New tests: `test/broker-side.test.ts` (7 new `liveExitOrderCoverage` OCO-pairing cases);
`test/broker-protective-stops.test.ts` (tracked-extreme seeding, native-lane refusal below tracked
extreme, keep-existing-stop-when-replacement-refused). Full gate re-run green.

## Follow-ups / risks

- **Live-verify the RH ratchet lane before enabling `robinhoodBrokerStops`** — same standing
  caveat as the fixed lane (that flag remains default OFF).
- Broker-held trailing for Alpaca SHORT positions (buy-side trailing stop) — follow-up.
- Alpaca order-list mapping reports a resting trailing_stop as `stop_market` (`mapAlpacaOrderType`)
  — deliberate (coverage counts it as protection); revisit if the UI should label it "trailing".
- Per-position LLM stop plans: Planned row + design sketch in `docs/EFFORT-LOG.md`.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board) could NOT be updated from
  this cloud session (no Mac filesystem access) — next Mac-side agent should sync the mirror.
