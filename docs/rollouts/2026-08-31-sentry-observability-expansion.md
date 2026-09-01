# 2026-08-31 — Sentry Observability Expansion: Session Replay, Tracing & Privacy Redaction (Antigravity, `ag/sentry-observability-expansion`)

## Context & Objective
Expands Sentry observability in Socratic.Trade utilizing the organization's sponsored $5,000 credit tier under `jays-services`. Enables client Session Replay by default with complete financial text, media, and URL parameter masking, raises baseline distributed tracing to 0.2 across server/edge/browser, and guarantees zero runtime overhead and zero data transmission when Sentry DSN environment variables are absent.

## Changes Made
- **Client Session Replay Default-On**: Configured `replaysOnErrorSampleRate: 1.0` and `replaysSessionSampleRate: 0.1` in `instrumentation-client.ts`, gated on `NEXT_PUBLIC_SENTRY_DSN`.
- **Sensitive URL Scrubbing**: Added `sanitizeTelemetryUrl` in `src/lib/telemetry-sanitize.ts` and integrated it into `beforeAddRecordingEvent` in Session Replay, `beforeSend`, and `beforeSendTransaction` across client, server, and edge runtimes to strip account numbers, trade symbols, proposal IDs, tokens, and secrets from URLs and query parameters.
- **Robust Replay Disabling**: Normalized `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED` to recognize `false`, `0`, `off`, and `no`.
- **Distributed Tracing Default 0.2**: Raised default `tracesSampleRate` from 0.1 to 0.2 across `instrumentation-client.ts`, `sentry.server.config.ts`, and `sentry.edge.config.ts`.
- **Canonical Environment Template**: Updated `.env.example` with the new trace and replay defaults.

### Touched Files
- `instrumentation-client.ts`
- `sentry.server.config.ts`
- `sentry.edge.config.ts`
- `src/lib/telemetry-sanitize.ts`
- `.env.example`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-31-sentry-observability-expansion.md`

## Decisions & Trade-offs
- **Financial Privacy Paramount**: Full text masking (`maskAllText: true`), media blocking (`blockAllMedia: true`), and URL query parameter sanitization (`sanitizeTelemetryUrl`) prevent trading metadata, proposal IDs, or credentials from leaking into Sentry replays or transaction spans.
- **Dynamic Imports & Inertness**: All Sentry evaluation remains gated on DSN presence, ensuring local development, CI builds, and unit tests without credentials execute with zero performance overhead.

## Verification State
- `npm run lint` — passed with 0 errors.
- `npx tsc --noEmit` — passed with 0 errors.
- `npx vitest run test/sentry-inert.test.ts` — 9/9 passed.
- `npm test` — passed.
- `npm run build` — passed.

## Next Steps & Blockers
- Monitor Sentry dashboard under project `socratic-trade` for new Session Replays and performance traces once deployed.
- Complete auto-merge of PR #3141.

## Zero-Code Findings
- None.
