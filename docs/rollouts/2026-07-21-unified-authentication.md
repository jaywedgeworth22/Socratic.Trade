# Unified Authentication Rollout

- **Summary**: Implemented Unified Authentication across iOS and Web, bridging Google, GitHub, and Apple Sign-In seamlessly.
- **Why**: The iOS app previously only supported Apple Sign-In natively. To support Google and GitHub, we needed to use `ASWebAuthenticationSession` to initiate an OAuth flow on the web backend, then capture and inject the resulting stateless JWT back into the iOS native cookie jar.
- **Files Touched**:
  - `ios/project.yml`: Added `socratictrade://` URL scheme.
  - `ios/SocraticTrade/LoginView.swift`: Added Google and GitHub buttons; implemented `ASWebAuthenticationSession` flow.
  - `ios/SocraticTrade/MobileStore.swift`: Added `loginWithToken(jwt:)` to manually inject the returned session token into `HTTPCookieStorage`.
  - `app/api/mobile/auth-redirect/route.ts`: Built the custom intercept route to hand off the token from the Next.js server to the iOS URL scheme.
- **Verification**:
  - Ran `xcodegen` and `xcodebuild -project SocraticTrade.xcodeproj -scheme SocraticTrade build -destination 'generic/platform=iOS'` in `ios/`.
  - Build successfully generated and compiled the project with zero Swift errors.
- **Follow-ups**:
  - The website Apple Sign-In logic is already built-in, but requires an Apple Services ID. The owner must generate the Web Client ID in the Apple Developer Portal and inject `AUTH_APPLE_ID` and `AUTH_APPLE_SECRET` into the Coolify server's `.env`.
