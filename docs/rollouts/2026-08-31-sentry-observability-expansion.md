# 2026-08-31 — Sentry observability expansion: Session Replay, increased trace sampling, and privacy-safe telemetry (Antigravity, `ag/sentry-observability-expansion`)

## Summary
Expands Sentry observability in Socratic.Trade to take advantage of the fleet's $5,000 sponsored credit tier in organization `jays-services`:
- **Session Replay enabled by default**: On the browser client, Session Replay is active by default when `NEXT_PUBLIC_SENTRY_DSN` is configured (`replaysOnErrorSampleRate: 1.0`, `replaysSessionSampleRate: 0.1`).
- **Privacy & financial data protection**: Strictly enforces `maskAllText: true`, `blockAllMedia: true`, `sendDefaultPii: false`, and `redactForTelemetry` on all outgoing events, ensuring no account balances, positions, or sensitive tokens leave the client.
- **Distributed tracing**: Increased baseline `tracesSampleRate` from 0.1 to 0.2 across server, edge, and client configurations.
- **Inert when unconfigured**: Completely inert when no DSN is provided, ensuring zero overhead in local dev/tests without Sentry environment variables.

## Verification
- `npx vitest run test/sentry-inert.test.ts` — 9/9 passed.
- `npx tsc --noEmit` — 0 errors.
