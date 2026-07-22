# Retired-provider Usage Monitor cleanup

## Summary

Retires Usage Monitor forwarding for Alpaca, Tradier, and Robinhood without removing or changing
their broker functionality. It also removes the dead Intrinio provider implementation and current
configuration/documentation, while retaining historical rollout evidence.

## Behavior

- Alpaca, including its `alpaca-news` and `alpaca-snapshot` subproviders, Tradier, and Robinhood
  remain available for trading, account reads, and API-health reporting.
- Their call-volume and broker-balance events are no longer forwarded to Usage Monitor.
- A central provider-family policy prevents retired broker names and subproviders from being
  admitted if a future call site accidentally tries to record them.
- Paid providers remain eligible for Usage Monitor forwarding; the regression suite uses FMP as
  the control.
- The unused Intrinio provider, API-key resolution, environment example, and current planning
  references are removed. Historical rollouts, reviews, and handoffs are deliberately unchanged.

## Files

- `.env.example`
- `src/lib/alpaca.ts`
- `src/lib/tradier.ts`
- `src/lib/robinhood.ts`
- `src/lib/data-providers.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/usage-monitor-provider-policy.ts`
- `src/lib/usage-monitor-push.ts` (after PR #1889 lands)
- `test/usage-monitor-provider-policy.test.ts`
- `test/usage-monitor-push.test.ts` (after PR #1889 lands)
- Current provider/broker/Usage Monitor docs
- `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md`

## Verification

- Node 24 focused gate before strict-v2 integration: 5 files / 209 tests passed.
- TypeScript `--noEmit` and `git diff --check` passed before strict-v2 integration.
- The final gate will run after adopting the exact merge of PR #1889 so its event schema,
  partial-ACK handling, replay admission, and cutover behavior are verified together.

## Dependency and release state

PR #1889 owns the direct strict-v2 Usage Monitor transport and its tests. This branch does not
modify those files until #1889 merges. It will then integrate the retired-provider boundary on
current `main`, run the authoritative Node 24 gate, and open a ready review PR. Merge and deployment
remain owner-controlled.
