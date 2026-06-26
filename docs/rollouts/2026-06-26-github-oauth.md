# 2026-06-26 — GitHub OAuth as alternative sign-in provider

## Summary

Added GitHub OAuth alongside Google OAuth so the login page is usable when only one
provider is configured. Before this change, a deployment with `AUTH_SECRET` set but no
Google credentials would show the login page with no way to sign in.

## Why

The login page showed "Auth provider not configured" (with no sign-in button) whenever
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` were missing — even if `AUTH_SECRET` was set,
arming the auth gate. Adding GitHub OAuth gives a second option that's equally easy to
provision and covers the common case where operators have GitHub but not a GCP project.

## Files

- `src/lib/auth/auth.ts` — conditionally registers Google and/or GitHub providers based
  on which env vars are present. Both can be active simultaneously.
- `app/login/page.tsx` — renders sign-in buttons for whichever providers are configured;
  updated "no provider" hint to mention both Google and GitHub.
- `.env.example` — documents `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET` with GitHub OAuth App
  setup instructions (Settings → Developer settings → OAuth Apps).

## Verification

```
npx tsc --noEmit   # clean
npm test           # 1250/1250 passed
npm run build      # clean, /login compiled as static
```

## Follow-ups

- The GitHub OAuth callback URL must be added in the GitHub OAuth App settings:
  `https://<your-domain>/api/auth/callback/github`
- Infisical: add `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` to the `agentic-trading`
  project when provisioning.
