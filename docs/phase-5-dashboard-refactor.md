# Phase 5 - Frontend Refactor And Charts

## Goals

- Split dashboard UI into typed feature components.
- Replace broad `any` usage with shared dashboard types.
- Add performance and allocation charts without making the interface marketing-heavy.
- Make refresh failures visible.
- Improve custom allowlist editing with validated tags.

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
- Refresh errors are shown in the UI and do not silently disappear.
- Empty states are explicit for positions, orders, scans, proposals, and performance.
- Custom universe editing validates symbols, normalizes case, and prevents duplicate tags.
