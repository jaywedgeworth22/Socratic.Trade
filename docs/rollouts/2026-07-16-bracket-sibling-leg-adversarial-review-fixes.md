# 2026-07-16 — Bracket sibling-leg teardown: adversarial review follow-up (2 confirmed bugs fixed)

## Summary

PR #1661 (bracket sibling-leg cancellation for Alpaca + Tradier) merged the same day with no
automated code review — Codex hit its usage-limit cap on both #1661 and its docs follow-up
#1662 and posted only a usage-limit notice, not a review. Since this touches real order
placement/cancellation on a live-money app, ran two independent adversarial review passes
(one correctness/race-focused, one money-path/financial-risk-focused) against the merged
code (`a5c27e8`) instead of leaving it unreviewed. Both passes independently surfaced the
SAME two genuine, confirmed bugs, plus a third distinct one from the correctness pass that
turned out (after grounded research) to not actually apply to this codebase's Tradier model.
Fixed the two confirmed bugs; the third was investigated and reverted/corrected rather than
"fixed" as originally proposed — see below.

## Findings and fixes

### 1. CONFIRMED — a same-style scale-in orphaned the OLD bracket's legs forever

`enqueueBracketTeardownIfLeavingDistancePlan` (`src/lib/db-api-keys.ts`) only compared
`nextStyle === previousStyle` to decide whether a teardown was needed. But a scale-in that
re-affirms the SAME style (e.g. `fixed` -> `fixed`) places a brand-new, independent
broker-native bracket for the added shares — Alpaca/Tradier brackets are independent OCO
groups; nothing cancels an EARLIER bracket when a later one is placed. Because only the
style was compared, the `opening_order_id` UPSERT silently overwrote the old bracket's order
id with the new one, and the old bracket's take-profit/stop-loss legs became permanently
unreachable — resting on the broker forever, potentially alongside whatever protection the
position later switched to (a double-exit-mechanism risk, exactly the class of bug this
whole feature exists to prevent).

**Fix:** `enqueueBracketTeardownIfLeavingDistancePlan` now takes the NEXT opening order id
too and only skips enqueueing when `nextStyle === previousStyle && nextOpeningOrderId ===
previousOpeningOrderId` — i.e. truly nothing changed (a rationale/avgCost-only rewrite). Any
other combination (style change, OR same style with a genuinely new bracket order id)
enqueues a teardown for the stale order.

### 2. CONFIRMED — `cancelBracketSiblingLegs` never threw, so the bounded-retry mechanism was dead code

Both Alpaca's and Tradier's `cancelBracketSiblingLegs` swallowed every failure (the initial
order lookup AND each per-leg cancel) into a plain `{ cancelledOrderIds: [] }`. But
`reconcilePendingBracketTeardowns` (`broker-protective-stops.ts`) only bumps
`attempts`/retries when the gateway call *throws* — which, with both adapters as originally
shipped, could never happen. Net effect: a transient lookup failure (network blip,
rate-limit, 5xx) was silently and permanently treated as "nothing to cancel" on the very
first sweep, removing the row and logging a success-shaped `bracket_sibling_legs_torn_down`
audit event even though the legs were never actually reached — `MAX_BRACKET_TEARDOWN_ATTEMPTS
= 10` never engaged in practice.

**Fix:** both adapters now distinguish "the order is genuinely gone" (safe to resolve as
done) from any other failure (must propagate so the reconciler's retry actually retries):
- Alpaca: only a real `404` on the nested-order GET resolves as done; anything else re-throws.
- Tradier: Tradier signals "not found" two ways — a genuine HTTP 404, or (per its own
  validation convention) a `200` response with an `{errors: {error: "..."}}` envelope that
  carries no HTTP-status prefix at all. Both are treated as "gone, safe to resolve"; anything
  else (including an unrelated validation error) propagates.

Per-leg cancel failures inside the loop remain intentionally swallowed on both adapters —
a leg that filled/cancelled between the lookup and the cancel attempt is a legitimate,
harmless race, not a signal to retry the whole teardown.

### 3. Investigated, NOT applied as originally proposed — Tradier "could cancel the entry order itself"

One reviewer flagged that Tradier's `cancelBracketSiblingLegs` has no leg-identity check
excluding the entry leg, and that a partially-filled entry (recorded as `openingOrderId` per
`performance.ts`) could get cancelled as a false "sibling." An initial fix (skip the first
row returned by `equityRowsFromTradierOrder`, assuming it's always the entry) was applied,
then reverted after checking it against this codebase's own PRE-EXISTING, tested model of
Tradier's response shape: `equityRowsFromTradierOrder`'s own doc comment and its
`getEquityOrders` coverage test (predating this PR, from an earlier "codex-autofix
reconciliation" round) both model a resting otoco/oco container's `leg` array as containing
ONLY the take-profit/stop-loss exit legs — the entry itself is never one of the container's
enumerated legs. Grounded web research (Tradier's own docs/description of OTOCO as "three
simultaneous orders" with indexed submission legs) could not conclusively confirm the GET-back
shape either way, so the established, already-tested precedent in this codebase was kept
rather than overridden by an unconfirmed guess — "skip the first leg" would have actively
broken the (still-passing) pre-existing sibling-cancellation test by skipping a genuine
take-profit/stop-loss leg.

What DID turn out to be a genuine, confirmed gap in the same area: when `container.class ===
"equity"` (no bracket was ever attached — e.g. Tradier's market-type-entry fallback in
`placeEquityOrder`, where `openingOrderId` is still recorded even though no bracket exists),
`equityRowsFromTradierOrder` returns the entry order ITSELF as its `[itself]` fallback row,
and iterating that WOULD treat the lone entry order as a cancellable "sibling." Fixed by
special-casing `class === "equity"` to a no-op before any leg iteration.

## Files

- `src/lib/db-api-keys.ts` — `enqueueBracketTeardownIfLeavingDistancePlan` gained a
  `nextOpeningOrderId` parameter; both call sites (`recordStopPlan`, `clearStopPlans`) updated.
- `src/lib/alpaca.ts` — `cancelBracketSiblingLegs` only swallows a genuine 404; anything else
  propagates.
- `src/lib/tradier.ts` — `cancelBracketSiblingLegs` only swallows a genuine "not found" (404
  or the 200-with-errors-envelope form); anything else propagates. Added an early no-op for
  `container.class === "equity"` (no bracket ever attached).
- `test/position-stop-plans-db.test.ts` — rewrote the "same distance-plan family, no teardown"
  test (its premise was the bug) to assert a teardown IS now enqueued for the stale order id;
  added a new test for the genuinely-no-op same-style/same-order-id case.
- `test/alpaca-brackets.test.ts` — mock `sendRequest` can now simulate a thrown error; added
  tests for the 404-resolves-as-done and non-404-propagates cases.
- `test/tradier.test.ts` — added tests for: entry-only order (class=equity, still open) never
  gets cancelled; genuine HTTP 404 resolves as done; the 200-with-errors "not found" envelope
  resolves as done; any other failure (503) propagates.

## Verification

```bash
npx tsc --noEmit                                                                    # clean
npx vitest run test/alpaca-brackets.test.ts test/tradier.test.ts \
  test/position-stop-plans-db.test.ts test/broker-protective-stops.test.ts \
  test/strategy-hardening.test.ts                                                  # 229/229 passed
npm test                                                                            # full suite
```

## Follow-ups

- Same as the original PR #1661 rollout note: unverified against a live Tradier account;
  `pending_bracket_teardowns` rows exceeding `MAX_BRACKET_TEARDOWN_ATTEMPTS` still have no
  alerting/surfacing; Robinhood remains without bracket support.
- The money-path review separately flagged (as an already-disclosed, unresolved risk, not a
  newly-introduced bug) that Tradier's per-leg `status` field may not exist independently of
  the container once the entry has filled — genuinely unverifiable without a live account;
  the first live Tradier bracket fill remains the real acceptance test for this whole feature.
