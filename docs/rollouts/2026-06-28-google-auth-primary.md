# 2026-06-28 - Google auth primary

## Summary

- Made Auth.js Google sessions the app's configured identity source.
- Stopped trusting Cloudflare Access email headers in middleware while keeping
  Cloudflare Tunnel-compatible public-origin handling.
- Changed `/logout` to clear Auth.js cookies and return to the app `/login`
  page instead of calling `/cdn-cgi/access/logout`.
- Changed empty `ALLOWED_EMAILS` from "defer to Cloudflare Access" to
  "allow only the primary operator and aliases."
- Updated auth tests and active docs to match the Google-auth contract.

## Why

The production site should stay reachable through the Cloudflare tunnel but use
Google login as the site auth layer. Keeping Cloudflare Access as a trusted
identity source made reconnect/login behavior dependent on the outer gateway and
kept reintroducing the old Access-owned session path.

## Files

- `middleware.ts`
- `app/login/page.tsx`
- `app/logout/route.ts`
- `src/lib/auth/identity.ts`
- `src/lib/request-user.ts`
- `.env.example`
- `test/middleware-auth.test.ts`
- `test/logout-route.test.ts`
- `test/auth-identity.test.ts`
- `docs/phase-11-multi-user.md`
- `docs/deployment.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-28-google-auth-primary.md`

## Verification

- `npx vitest run test/middleware-auth.test.ts test/logout-route.test.ts test/auth-identity.test.ts test/request-user.test.ts` - passed, 4 files / 26 tests.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 153 files / 1,488 tests.
- `npm run build` - passed; Next.js emitted the existing middleware-to-proxy deprecation warning.

## Follow-ups

- After deployment, confirm the Cloudflare Access application or policy no
  longer intercepts `trading.jays.services`; app code cannot show Google login
  if Access blocks the request before it reaches Next.js.
- Confirm production Infisical has `AUTH_SECRET`, `AUTH_GOOGLE_ID`,
  `AUTH_GOOGLE_SECRET`, `PRIMARY_USER_EMAIL`, and any intended
  `PRIMARY_USER_EMAIL_ALIASES` / `ALLOWED_EMAILS` values.
