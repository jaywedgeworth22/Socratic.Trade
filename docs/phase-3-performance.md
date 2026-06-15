# Phase 3 - Performance Tracking And Reconciliation

## Goals

- Persist portfolio snapshots, fill events, and run attribution.
- Track Paper results separately from Live broker results.
- Show whether the strategy is making or losing money.
- Keep live reconciliation best-effort when the broker adapter does not expose final fill data.

## Storage

- `portfolio_snapshots`: run id, account, source (`live` or `paper`), equity, cash, buying power, positions, created time.
- `fill_events`: proposal id, run id, account, source, side, symbol, quantity, price, notional, status, broker order id, raw payload.
- `notification_events`: used by Phase 6 but included with the persistence migration.
- `strategy_profiles`: used by Phase 6 but created with the migration so profile state is durable.

## Calculations

- FIFO realized P&L per source.
- Unrealized P&L from current positions and latest prices where available.
- Equity curve from snapshots, separated into live and paper series.
- Run attribution from fill events grouped by run id.
- Win rate and average return from closed FIFO lots.

## Acceptance

- Every strategy run records a portfolio snapshot before proposal execution and after reconciliation.
- Paper executions create fill events with reviewed notional and estimated price.
- Live executions create pending or filled fill events depending on available broker state.
- Dashboard API returns `PerformanceSummary` for charting.
