# 2026-08-27 — iOS OAuth return-to-app + workspace decode (both owner-reported, both root-caused live)

## Context & Objective

Owner re-reported after #3116/#3117: (A) Google/GitHub sign-in completes but the
ASWebAuthenticationSession sheet loads the signed-in mobile WEBSITE instead of
returning to the app; (B) Apple sign-in works, then "Couldn't load your workspace.
Try again."  Owner directed the Grok local agent to implement; both Grok dispatch
modes died (its 127.0.0.1:8317 completion endpoint refused; the leader-socket retry
produced nothing — the fleet's known seat-mcp grok empty-death), so MONET landed the
fixes directly per the owner's fallback.

## Root causes (verified against production, not theorized)

- **(A)** `sameOriginCallback` in `app/api/mobile/auth-start/route.ts` validated the
  incoming absolute callbackUrl against `new URL(request.url).origin` — inside the
  Coolify container that is the INTERNAL origin, not `https://socratictrade.com`, so
  every legitimate callback failed the check and collapsed to "/".  Verified live:
  the `__Secure-authjs.callback-url` cookie held the bare origin.  After the provider
  callback, Auth.js sent the sheet to the site root; the `socratictrade://auth`
  handoff never fired.
- **(B)** That alert text is `MobileAPIError.decoding` (MobileAPIClient.swift:36).
  The server's `EquityCurvePoint` (src/lib/types.ts) keys curve points by
  `timestamp`; the shipped Swift `EquityCurvePoint` hard-required `date`.
  `keyNotFound(date)` → `PerformanceSummary` throws → `performance` was a hard
  `try` decode → the WHOLE snapshot decode failed.  Verified by fetching the live
  authenticated snapshot (session minted in-container, never printed) and diffing
  its schema against the shipped models.  #3117's latency theory was wrong — the
  server half of that PR is still a real improvement, but not this bug.

## Changes Made

- `src/lib/mobile-auth-start.ts` (new) — `publicOrigin(headers)` (x-forwarded-proto/
  host with canonical fallback) + `sameOriginCallback` accepting the request's public
  origin or the canonical origin; still clamps cross-origin to "/".
- `app/api/mobile/auth-start/route.ts` — uses the public origin for callback clamping
  and the login fallback; helpers moved out (route modules may only export handlers).
- `src/lib/mobile-equity-curve-compat.ts` (new) + `app/api/mobile/snapshot/route.ts` —
  every live/paper equity-curve point on the MOBILE wire now also carries
  `date` (= `timestamp`); console shape untouched.  Fixes ALL shipped builds on deploy.
- `ios/SocraticTrade/MobileModels.swift` — `EquityCurvePoint` decodes `date` OR
  `timestamp`; `MobileSnapshot.init` decodes `performance` with the defensive
  `(try? ...)` pattern so display-only enrichment can never blank the workspace again.
- Tests: `test/mobile-auth-start.test.ts` (rewritten against the lib; covers the
  internal-origin regression case), `test/mobile-equity-curve-compat.test.ts` (new),
  two new XCTests in `MobileModelsTests.swift` (timestamp-keyed points decode; fully
  malformed performance degrades to nil).

## Decisions & Trade-offs

- Server-side compat alias chosen over renaming the shared `EquityCurvePoint` type —
  the console consumes `timestamp` and must not churn.
- `publicOrigin` trusts `x-forwarded-host` — correct behind Traefik/Cloudflare which
  always set it; the canonical-origin fallback keeps the clamp safe if headers are
  absent.

## Verification State

- `npx tsc --noEmit` clean; `npm run lint` 0 errors; new vitest files 12/12 green;
  full `tsc → vitest → build` gate via `scripts/land.sh`.
- Swift compiles + XCTests on hosted `ios-build` (no local xcodebuild).
- Post-deploy live checks: the auth-start Set-Cookie for `__Secure-authjs.callback-url`
  must contain `/api/mobile/auth-redirect`; the authenticated snapshot's
  `performance.liveEquityCurve[0].date` must exist.

## Next Steps & Blockers

- After deploy, owner retest on-device: Google/GitHub should round-trip into the app;
  Apple sign-in should load the workspace (installed build, no update needed).
- Grok seat infra: both headless dispatch modes are dead (8317 refused / leader
  silent) — filed observation for the fleet; not this repo's scope.
