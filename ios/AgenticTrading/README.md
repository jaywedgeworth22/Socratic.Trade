# Agentic Trading iOS Client

SwiftUI starter for the native iPhone control surface. The backend remains the
source of truth: this app stores only the server session/token, submits commands
to `/api/mobile/commands`, reads `/api/mobile/snapshot`, and listens to
`/api/mobile/events`.

## Target Setup

1. Create an iOS SwiftUI app target in Xcode.
2. Add the Swift files from this directory to the target.
3. Set the backend base URL in `AgenticTradingApp.swift`.
4. Use `ASWebAuthenticationSession` or an embedded system browser session for
   backend login. Store only the resulting server session token/cookie in
   Keychain or the system cookie store.

Provider keys, broker credentials, scraping, calculations, MCP calls, and order
placement stay behind the backend API.

## Account Deletion

The iOS app should use the same multi-step backend flow as the PWA:

1. `POST /api/mobile/account-deletion/request`.
2. Show the returned warning steps, signed-in email/user id, and required text.
3. `POST /api/mobile/account-deletion/confirm` with `requestId`,
   `typedIdentity`, and `typedText`.
4. On success, clear local session state and open `/logout`.

This deletes the app-side account data and server-stored secrets. Revoking the
OAuth grant inside Google or Apple account settings is a separate provider-side
action.
