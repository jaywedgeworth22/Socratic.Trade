# 2026-07-09 — Broker-minimum handling: bump-to-floor (owner ruling)

## Summary

Below-broker-minimum orders (e.g. Robinhood's $1 floor) are now **bumped up to the floor** instead
of skipped — `policy.brokerMinimumHandling`, default `"bump"`, with `"skip"` preserved as the
off-switch (pre-ruling #1167 behavior).

- `src/lib/broker-minimum-guard.ts`: new `resolveBrokerMinimum(review, activeBroker, order, mode)`
  → `proceed | block | bump{patch, becomesFullExit, note}`. Dollar-based orders bump to exactly the
  floor (broker executes the literal amount); fractional-quantity orders bump with a 2% price-drift
  headroom, rounded UP at 1e-6 precision; a sell/cover whose bump meets the whole held position is
  capped there and becomes an exempt full-position (dust) exit. Unknown-broker floors and orders
  with no usable sizing basis fail safe to block.
- `src/lib/strategy.ts` (both pre-flight sites — autonomous loop + human-approval path): on `bump`,
  the patched order is **re-reviewed once** (no loops — if the re-review still lands below minimum,
  it takes the block path), an `order_bumped_to_broker_minimum` audit records original→bumped
  params, and the proposal/review bindings are rebound so **everything downstream — including
  `evaluateTradeProposal` — runs on the bumped size**.

## Why (and why this design is safe where #1169 wasn't)

Owner ruling 2026-07-09 ("bump up") on the question left open when PR #1169 was disarmed. #1169
bumped inside `applyDeterministicSizing`, which could over-size beyond `maxOrderPctOfNav` intent and
competed with #1167's skip-guard. This implementation bumps **before** the policy gate, so every
deterministic cap (per-order notional, NAV%, daily notional, buying power) evaluates the bumped
size — a bump can never over-size past the owner's caps; if the floor itself violates a cap, the
normal policy engine blocks it with an honest reason.

## Files

- `src/lib/broker-minimum-guard.ts` — `resolveBrokerMinimum` + constants (+106)
- `src/lib/strategy.ts` — both call sites rewired (const→let rebind + bump stanza)
- `src/lib/types.ts` — `TradingPolicy.brokerMinimumHandling?: "bump" | "skip"`
- `src/lib/defaults.ts` — `brokerMinimumHandling: "bump"`
- `test/broker-minimum-guard.test.ts` — 8 new `resolveBrokerMinimum` tests (22 total in file)

## Verification

- `npx tsc --noEmit` clean; guard suite 22/22 + new 4-test integration file
  (`test/broker-minimum-bump-execute.test.ts`, drives the REAL executeProposal through a mocked
  BrokerGateway) = 32 green; full land.sh gate.
- Adversarial 4-lens review workflow (money-path correctness, records consistency, edge cases,
  test adequacy) run on the diff pre-land. Findings fixed in-branch:
  - **Dollar-based sell/cover had no position cap** (converged across 2 lenses): a $0.22 dollar
    trim of a $0.70 position would bump to a $1.00 sell exceeding the whole position — and the
    policy engine's holdings checks no-op on dollar orders. Now: position value at/below
    floor(+headroom) converts to a full-position share exit (exempt dust exit); unknown position
    value on a sell/cover fails safe to block. Unit-tested.
  - **Crash-recovery booked fills at pre-bump size** (approval path): the stored row kept the
    original proposal JSON while the broker got the bumped order — `flagStalePlacingIntents`
    would book a recovered fill ~4x under-sized. Now `claimProposalForExecution` persists the
    execution-time proposal JSON. Integration-tested (row shows bumped sizing after placement).
  - Still-blocked one-shot fallback now rebinds to the bumped order first so the blocked record
    consistently shows the order actually attempted.
  - Whole-share+dollarAmount hybrid orders fail safe to block instead of silently re-basing.
  - Accepted (documented, not fixed): the run-loop bump audit carries no proposalId (the id is
    minted later) — joinable by runId+symbol; typed live-confirmations are validated pre-bump, so
    a bump can raise the placed notional to ≤ ~$1.02 above the confirmed number (bounded,
    owner-ruled default; both sizes in the audit event; no re-confirmation ceremony added).

## Follow-ups

- Settings UI control for `brokerMinimumHandling` deferred — the guardrails page + field-defs are
  claimed by the active stop-loss lanes (collision avoidance); default already implements the
  owner's chosen behavior. Add the toggle when those lanes land.
- PR #1169 to be closed as superseded once this merges.
