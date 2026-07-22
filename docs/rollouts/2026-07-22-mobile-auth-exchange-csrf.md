# Mobile auth exchange CSRF follow-up — 2026-07-22

## Summary

Kept `/api/mobile/auth/exchange` unauthenticated for the native client without bypassing the
middleware same-origin CSRF guard. Added a regression proving cross-site POSTs are rejected.

## Why

The prior middleware change placed the exchange route in `PUBLIC_PREFIXES`, causing an early return
before `checkSameOrigin`. That allowed a browser-signaled cross-site POST to reach the cookie-setting
route. The opaque one-time code and device verifier authorize the native handoff, but they do not
prove that the current browser intended to accept the login.

## Files

- `middleware.ts`
- `test/middleware-auth.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-07-22-mobile-auth-exchange-csrf.md`

## Verification

Run the focused middleware and mobile auth exchange tests, then run the required hosted `verify`
workflow before merge.

## Follow-ups

No production native distribution is claimed; TestFlight/App Store release remains separate.
