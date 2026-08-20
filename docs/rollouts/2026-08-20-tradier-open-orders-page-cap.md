# Tradier default getEquityOrders must walk old GTC opens

## Context & Objective

#2886 (`broker-io-deadlines`) scoped default Tradier `getEquityOrders` to 5 pages plus a 24h terminal filter.  Tradier has no `status=open` query, so resting GTC equity exits on page 6+ disappeared from `liveExitOrderCoverage`.  The synthetic-stop monitor then treated the position as uncovered and could place a second sell.

## Changes Made

- Default and `fullHistory` both walk `TRADIER_ORDERS_MAX_PAGES` (50).
- Client-side filter still keeps every working order and only recent terminal rows unless `fullHistory` is set.
- Regression test: five option-only pages, equity stop on page 6, default list still returns it.

Touched files:

- `src/lib/tradier.ts`
- `test/tradier.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-20-tradier-open-orders-page-cap.md`

## Decisions & Trade-offs

- Did not add a Tradier `status` query — the public list endpoint does not expose one.
- Did not change Alpaca.  Alpaca already fetches `status:"open"` separately, so old GTC opens are not dropped.
- Quiet accounts still stop on an empty or fully-duplicate page, so the 50-page cap is only a bound, not a forced walk.

## Verification State

```bash
npx tsc --noEmit
npm test -- test/tradier.test.ts test/broker-io-deadlines.test.ts
```

## Next Steps & Blockers

- Review + merge.  No deploy from this seat.

## Zero-Code Findings

None.
