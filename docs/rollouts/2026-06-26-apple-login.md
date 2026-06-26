# 2026-06-26 — Apple Sign In provider

## Summary

Added Apple as a third OAuth sign-in option alongside Google and GitHub.

## Why

User request. Apple Sign In is a common and privacy-respecting identity choice, particularly
for operators who use Apple devices and have an Apple Developer account.

## Files

- `src/lib/auth/auth.ts` — conditionally registers Apple provider when `AUTH_APPLE_ID` and
  `AUTH_APPLE_SECRET` are present; updated `signIn` callback to reject Apple sign-ins where
  no email is returned (covers the null-email case and documents the first-auth-only caveat).
- `app/login/page.tsx` — added `appleConfigured` check, Apple sign-in button (dark styled per
  Apple HIG), `AppleIcon` SVG component; updated "not configured" hint to mention Apple vars.
- `.env.example` — documents `AUTH_APPLE_ID` / `AUTH_APPLE_SECRET` with full Apple Developer
  Portal setup steps and a warning about Apple's first-authorization-only email behavior.

## Apple-specific caveats (operator must know)

1. **Email only on first authorization.** Apple sends the user's email once — at the moment
   they first authorize the app. Subsequent re-authorizations (e.g. after session expiry or
   cookie clear) will NOT include the email, and the `signIn` callback will reject the attempt.
   The session JWT cookie has a 30-day lifetime, which covers normal usage. **Keep at least
   one other provider (Google or GitHub) active** so users can always sign back in.

2. **Client secret expires.** The `AUTH_APPLE_SECRET` is a JWT you generate using your Apple
   private key. It is valid for up to 6 months and must be regenerated and re-injected before
   it expires. Set a calendar reminder; an expired secret blocks all Apple sign-ins.

3. **Private relay email.** If the user chooses "Hide My Email", Apple provides a proxy
   address (`xxx@privaterelay.appleid.com`). This address will NOT match `PRIMARY_USER_EMAIL`
   or a typical `ALLOWED_EMAILS` entry — add the relay address to `ALLOWED_EMAILS` if needed.

4. **Callback URL.** The Apple Services ID must list:
   `https://<your-domain>/api/auth/callback/apple`

## Generating AUTH_APPLE_SECRET

```bash
npx auth apple-secret AUTH_APPLE_ID TEAM_ID KEY_ID /path/to/AuthKey_XXXXX.p8
```

Replace the placeholders with your Apple Developer values. The output is a JWT — set it as
`AUTH_APPLE_SECRET` in Infisical or `.env.local`.

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1253/1253 passed
npm run build      # clean, /login still ƒ (Dynamic)
```
