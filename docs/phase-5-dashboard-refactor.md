# Phase 5 - Frontend Refactor And Charts

## Goals

- Split dashboard UI into typed feature components.
- Replace broad `any` usage with shared dashboard types.
- Add performance and allocation charts without making the interface marketing-heavy.
- Make refresh, render, and browser runtime failures visible.
- Improve custom allowlist editing with validated tags, including quote-checked
  non-index U.S. equity/ETF tickers.

## Components

- Scheduler/status summary
- Performance charts
- Allocation chart
- Policy and risk controls
- Profile controls
- Market scan table
- Pending proposals
- Run history
- Audit log

## Acceptance

- `DashboardSnapshot` is a shared type used by the dashboard client.
- Refresh, render, and uncaught browser runtime errors are shown in the UI and do
  not silently disappear.
- Empty states are explicit for positions, orders, scans, proposals, and performance.
- Custom universe editing validates symbols, normalizes case, prevents duplicate
  tags, accepts quote-resolvable non-index tickers, and explains why a custom
  ticker cannot be saved when no quote is available.
