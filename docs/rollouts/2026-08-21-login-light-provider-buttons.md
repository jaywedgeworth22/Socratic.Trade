# Login provider buttons: one light pill, matching monochrome marks

Date: 2026-08-21 · Agent: CURSOR · Branch: `cursor/login-light-provider-buttons`

## 1. Context & Objective

Owner review of the sign-in row: the light white Google button (hairline border, soft
shadow, icon + label grouped in the middle) is the look to copy.  Do not add email or
password fields.  Passkey was named as a maybe and is not in this change.  Apply that
same light pill and the same monochrome mark style to Google, GitHub, and Apple on both
the website and iOS.

## 2. Changes Made

The website still had three unrelated treatments (teal Google, outline GitHub, inverted
Apple) with a four-color G.  iOS was already a uniform light row from #3008, but kept
the colorful G, a 10pt radius, and left-aligned logos.  Both clients now share one
component: white (dark: near-black) capsule, hairline border, soft shadow, centered
icon + title, marks drawn in the button ink.

Touched files:

- `app/login/page.tsx` — shared `PROVIDER_BUTTON_CLASS`; Google/GitHub/Apple icons
  `fill="currentColor"` at 20px
- `ios/SocraticTrade/LoginView.swift` — `Capsule` fill, centered content, monochrome
  `GoogleMark(ink:)`
- `test/login-provider-buttons.test.ts` — locks the shared pill, monochrome marks, and
  no email/password/passkey fields
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

- **No email/password.**  Owner: do not mess with those options.  The page stays
  Google / GitHub / Apple OAuth.  Auth.js `credentials` is not added.
- **No passkey.**  Named as a maybe.  JWT sessions have no credential store, so
  WebAuthn would be a new adapter and enrollment path, not a button restyle.
- **Monochrome G, not the four-color G.**  Google's custom-button kit prefers the
  color G on a light/neutral fill.  Owner asked for the same mark style on all three,
  matching the charcoal G on the reference light button.  Letterform is unchanged.
- **Pill, not 10pt radius.**  Apple's HIG allows a custom corner radius on a custom
  Sign in with Apple button.  Capsule matches the reference and the other two rows.
- **Apple ink stays pure black/white.**  Google/GitHub keep #1F1F1F / #E3E3E3.  The
  difference is small; Apple's rule is absolute.
- **iOS title stays 19pt on 44pt.**  That is the HIG's own 43% pairing for a custom
  Sign in with Apple button.  Web uses `text-sm` on `min-h-11`.
- **Copy stays "Sign in with …".**  One of Apple's three permitted titles.  The
  reference used "Continue with Google"; this screen is sign-in.

## 4. Verification State

```bash
npx tsc --noEmit                          # clean
npm run lint                              # 0 errors, 774 pre-existing warnings
npm test -- test/login-provider-buttons.test.ts \
  test/middleware-auth.test.ts test/apple-web-auth.test.ts \
  test/apple-auth-route.test.ts test/auth-identity.test.ts \
  test/auth-github-email.test.ts test/logout-route.test.ts
                                          # 7 files / 67 passed
npm run build                             # exit 0, /login listed
```

A full `npm test` in this environment was started and killed after ~24 minutes:
unrelated files were already failing on outbound 404s (SEC company_tickers,
Alpaca quotes, FRED) and 30s strategy timeouts.  None of those files touch
login.  iOS: no `xcodebuild` here; first Swift compile is CI `ios-build.yml`.

## 5. Next Steps & Blockers

- Merge; website ships on the next `main` Coolify build (weekday RTH latch still
  applies).  iOS ships on the next TestFlight, not Coolify.
- Passkey remains a product decision: add only if the owner wants a fourth method
  that is not email/password.
- Screenshots of the light login row on web and iOS are still owed.

## 6. Zero-Code Findings

None.  Visual-only; sign-in actions, providers, and session handling are unchanged.
