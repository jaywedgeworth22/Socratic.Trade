# 2026-09-04 — Sentry Max Features (ST)

Board `af1ab6e9`.  Branch `grok/sentry-max-features`.  Worktree
`~/apps/trading-grok-sentry-max`.

## Changes

- Web Session Replay defaults to **error-only** (session sample 0%, error 100%,
  mask-all).  Designer omission: do not raise session Replay on socratictrade.com.
- User Feedback widget on (`NEXT_PUBLIC_SENTRY_FEEDBACK_ENABLED=false` kills it).
- iOS `profilesSampleRate = 0.1`.
- Kill switches: `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=false`, sample-rate env vars.

## Verification

- `npx vitest run test/sentry-tunnel-middleware.test.ts`
