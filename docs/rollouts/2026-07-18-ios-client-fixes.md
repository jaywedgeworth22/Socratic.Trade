# 2026-07-18 — Native iOS client: typed live-approval confirmation, SSE frame coalescing, typed API errors

## IMPORTANT: untested by compilation

This repo has no `.xcodeproj`/`.xcworkspace` for `ios/SocraticTrade/` (per its own
`README.md`, the files are meant to be dropped into a target created manually in
Xcode), and this session had no Xcode automation available to add one and build.
All Swift changes below were:

- Checked with `swiftc -parse` on each file (syntax only) — clean.
- Checked with `swiftc -typecheck` across all six files together against the
  **macOS** SDK (SwiftUI/AuthenticationServices both exist there too, so this
  catches real type errors even though it isn't the iOS SDK) — see the exact
  command/result in Verification below.

Neither of those is a substitute for an actual iOS build. **The owner should
open the project in Xcode, add these files to a target (or refresh existing
membership), and do one build (Cmd-B) before relying on this branch.** If
anything doesn't compile, it's most likely a small API-surface mismatch (e.g.
between the macOS and iOS overloads of a SwiftUI modifier), not a logic error —
flag it and it should be a quick fix.

## Summary

Fixed three related bugs in the native iOS client, filed as items 30-32 of the
app-review backlog:

- **Item 30** — the app could not approve a **live** brokerage proposal when
  the owner's policy requires typed confirmation
  (`policy.requireTypedConfirmation`, on by default): the iOS client only ever
  sent `{"proposalId": ...}`, never the `liveConfirmation` object the server
  requires for `broker/live` orders, so every such approval failed server-side
  with `LiveApprovalConfirmationError` and no way for the user to see why or
  retry correctly.
- **Item 31** — the SSE client fired its reload callback **twice per event**
  (once for the `event:` line, once for the `data:` line) and, worse, each
  callback spawned its own overlapping `load()` call with no de-duplication,
  so a burst of server events (a single strategy tick can emit several) could
  stack many concurrent snapshot fetches.
- **Item 32** — the API client collapsed every non-2xx response (500, a
  timeout mapped to `.badServerResponse`, a flaky network blip) into the same
  `URLError.badServerResponse`, and `MobileStore.load()` treated that as "the
  session died," clearing `isAuthenticated` and bouncing the user to the login
  screen — for a transient server hiccup, not just a real 401/403.

## Why

All three bugs share a root cause: the iOS client was built against a rough
sketch of the PWA's contract instead of mirroring its exact behavior. Each fix
below cites the exact PWA/server code it now mirrors.

### Item 30 — typed live-approval confirmation

Server contract (unchanged, no server edits here):
- `src/lib/mobile-api.ts` `normalizeCommandPayload` (`"proposal.approve"`
  case, ~line 396): accepts `{ proposalId, liveConfirmation? }` where
  `liveConfirmation` is passed through opaquely if present.
- `src/lib/mobile-api.ts` `runCommand` (~line 636): forwards
  `payload.liveConfirmation` into `executeProposal(...)`.
- `src/lib/strategy-execution.ts` `assertLiveApprovalConfirmation` (via
  `src/lib/strategy.ts` re-export) only runs this check when
  `executionMode === "broker/live"` **and**
  `policy.requireTypedConfirmation !== false`, and requires the confirmation's
  `proposalId`, `accountNumber`, `executionMode: "broker/live"`, `typedText`
  (must equal `liveApprovalText(symbol)` = `` `APPROVE LIVE ${symbol.trim().toUpperCase()}` ``),
  and `estimatedNotional` (within $0.01) to all match the reviewed proposal.
  A mismatch throws `LiveApprovalConfirmationError`, whose `.message` (the
  joined `reasons[]`) becomes the failed command's `error` field.
- `app/api/mobile/snapshot/route.ts` (~line 33) always includes
  `policy.requireTypedConfirmation: snapshot.policy.requireTypedConfirmation !== false`
  in the snapshot response.

PWA client parity mirrored exactly (`app/mobile/mobile-pwa-client.tsx`):
- `willPromptTyped = live && snapshot?.policy.requireTypedConfirmation !== false`
  where `live = proposal.executionMode === "broker/live"` (~line 681-684).
- `liveApprovalText(symbol)` (~line 174-176):
  `` `APPROVE LIVE ${symbol.trim().toUpperCase()}` ``.
- The `submitCommand("proposal.approve", { proposalId, liveConfirmation: {
  proposalId, accountNumber, executionMode: "broker/live", estimatedNotional,
  typedText } })` shape (~line 742-756).

iOS implementation:
- `ios/SocraticTrade/MobileModels.swift`: added
  `PolicySummary.requireTypedConfirmation: Bool?` (decoded optional, treated
  as "on" if missing — same `!== false` default as the server/PWA); added a
  free function `liveApprovalConfirmationText(forSymbol:)` mirroring
  `liveApprovalText`; added `LiveApprovalConfirmation`, a small struct whose
  `jsonObject` property builds the exact wire shape for
  `JSONSerialization` (omits `accountNumber` entirely when nil instead of
  boxing `Optional<String>.none` into `[String: Any]`, which
  `JSONSerialization` can't serialize — mirrors the PWA relying on
  `JSON.stringify` dropping `undefined` keys; sends `estimatedNotional` as an
  explicit JSON `null` when nil, mirroring the PWA's `?? null`).
- `ios/SocraticTrade/MobileControlView.swift`: the "Approve" button now checks
  `requiresLiveConfirmation(proposal)` (mirrors `willPromptTyped`). If true, it
  opens a native `.alert(...)` (title "Confirm Live Order") with a `TextField`
  bound to `liveConfirmationText`, matching the requested "SwiftUI alert with
  TextField" UX (the PWA instead shows an always-visible inline field per
  proposal; a modal alert is the natural native-iOS analog for a single
  in-context confirmation). The alert's "Approve" button is `.disabled` until
  the typed text (trimmed + uppercased) equals the expected phrase — mirrors
  the PWA's `livePhraseMatches` gate. On confirm, it submits
  `proposal.approve` with the full `liveConfirmation` payload. If the server
  still rejects it (e.g. the proposal's notional/account changed underneath
  the user), that rejection reason already surfaces honestly: it lands in the
  command's `error` field via the existing "Recent Commands" section
  (`MobileControlView.swift`, unchanged), which was already wired to show
  `command.error` — no separate error-surfacing path was needed for that part.

Non-live proposals, and live proposals when the owner has turned typed
confirmation off, still approve with a single tap exactly as before (no
regression to the fast path).

### View-body split (compile-tractability refactor, found by the typecheck)

The first `swiftc -typecheck` run failed with the Swift solver-budget error —
"the compiler is unable to type-check this expression in reasonable time" —
pointed at the Approvals `VStack` inside `MobileControlView.body` (the item-30
`if/else` in the Approve button closure pushed the already-large single-`List`
body expression over the type-checker's budget; this same error would fail a
real Xcode build too). Standard fix, applied in two steps:

- Extracted the per-proposal card into a private `ProposalApprovalRow` subview
  (proposal + preformatted notional text + `onApprove`/`onReject` closures).
- Split the rest of `body`'s `List` into one computed property per section
  (`errorSection`, `modeSection`, `portfolioSection`, `approvalsSection`,
  `watchlistSection`, `recentCommandsSection`, `deletionSection`), and moved
  the deletion button's compound `.disabled(...)` boolean into a
  `deleteConfirmDisabled(_:)` helper. Each computed property is type-checked
  as its own expression, so no single expression is huge. (After only the
  first step, a re-run still ground for 25+ minutes without finishing —
  expressions can sit just under the solver's error budget and take minutes
  each — hence the full per-section split.)

No behavior change intended in this refactor: every section's content, button
wiring, and the deletion gating boolean are verbatim moves.

### Item 31 — SSE frame coalescing

Server contract (unchanged, no server edits — the route already emits
spec-conformant SSE): `app/api/mobile/events/route.ts` `sendEvent` (~line 24)
writes each event as `` `event: ${name}\ndata: ${json}\n\n` `` — i.e. two
lines then a blank-line frame terminator — plus heartbeat/comment lines
(`": connected\n\n"`, `": ping\n\n"`) that start with `:` and carry no
`event:`/`data:` line.

iOS implementation (`ios/SocraticTrade/MobileAPIClient.swift`,
`events(onEvent:)`): previously fired `onEvent()` on **every** line starting
with `"event: "` or `"data: "` — i.e. twice per real SSE message. Rewrote it
to accumulate a `frameHasPayload` flag across lines and dispatch `onEvent()`
**once**, only when a blank line (the frame terminator) is reached and the
frame actually contained an `event:`/`data:` line (comment-only frames like
`": ping"` are correctly suppressed — they never should have triggered a
reload).

Reload coalescing lives on the consumer side, in
`ios/SocraticTrade/MobileStore.swift`: previously `startEvents()` spawned a
**new, unstructured `Task`** calling `self.load()` on every `onEvent()`
callback, so a burst of frames could have several `load()` calls in flight
concurrently with no ordering guarantee. Added `scheduleReload()`: if a
reload is already in flight, an incoming signal just sets a `reloadPending`
flag instead of starting a new one; the in-flight reload's completion then
loops to run exactly one more `load()` if a signal arrived meanwhile,
collapsing any number of frames received during a reload into a single
follow-up fetch. `startEvents()` now calls `scheduleReload()` instead of
`load()` directly.

### Item 32 — typed API errors, only 401/403 clears the session

`ios/SocraticTrade/MobileAPIClient.swift`: added `MobileAPIError` (`Error`,
`LocalizedError`) with four cases — `.unauthorized(statusCode:)`,
`.serverError(statusCode:, body:)`, `.network(Error)`, `.decoding(Error)`.
Both `send<T>(_:)` (used by every JSON request: snapshot, submit, account
deletion request/confirm, Apple login) and `events(onEvent:)` now route
through a single `requireSuccess(_:body:)` gate: transport failures become
`.network`, a 401/403 becomes `.unauthorized`, any other non-2xx becomes
`.serverError` (with the response body captured so `errorDescription` can
show the server's own `{"error": "..."}` message when present — mirrors the
PWA's `body.error ?? "Command failed."` pattern in `submitCommand`,
`app/mobile/mobile-pwa-client.tsx`), and a JSON decode failure on an
otherwise-2xx response becomes `.decoding` instead of silently corrupting an
unrelated error path.

`ios/SocraticTrade/MobileStore.swift`: replaced the old
`if let urlError = error as? URLError, urlError.code == .badServerResponse { isAuthenticated = false }`
check (which fired for *any* non-2xx, including a plain 500 or a timeout) with
`applyAuthAwareError(_:)`, which only clears `isAuthenticated` for
`MobileAPIError.unauthorized` — i.e. only a genuine 401/403. Applied
consistently in `load()`, `submit()`, `startAccountDeletion()`, and
`confirmAccountDeletion()` (all four now route their catch block through the
same helper, so a session that dies mid-action is detected wherever it's
observed, not only on the next snapshot poll). Left `loginWithApple()`'s catch
block untouched — the user isn't authenticated yet at that point, so there's
no "log out" behavior to fix there; it keeps its existing
`"Apple Sign-In failed: ..."` message prefix.

Scanned the other Swift files in `ios/SocraticTrade/` (`LoginView.swift`,
`SocraticTradeApp.swift`) for the same status-code-collapsing pattern —
neither touches HTTP status codes at all (`LoginView.swift`'s error handling
is for `ASAuthorizationError`, an unrelated native Apple Sign-In API), so no
further same-pattern fixes were needed. Confirmed via
`grep -n "statusCode\|badServerResponse\|HTTPURLResponse\|URLError" ios/SocraticTrade/*.swift`
that all status-code handling is now consolidated in
`MobileAPIClient.requireSuccess`, the single place this pattern used to be
duplicated.

## Files

- `ios/SocraticTrade/MobileModels.swift` — `PolicySummary.requireTypedConfirmation`,
  `liveApprovalConfirmationText(forSymbol:)`, `LiveApprovalConfirmation`.
- `ios/SocraticTrade/MobileAPIClient.swift` — `MobileAPIError`; `send`/`events`
  routed through a shared `requireSuccess` status gate; SSE line accumulation
  rewritten to dispatch once per frame.
- `ios/SocraticTrade/MobileStore.swift` — `scheduleReload()` coalescing;
  `applyAuthAwareError(_:)` replacing the old blanket
  `URLError.badServerResponse` check.
- `ios/SocraticTrade/MobileControlView.swift` — live-approval confirmation
  alert/TextField, `requiresLiveConfirmation`/`expectedLiveConfirmationText`/
  `liveConfirmationMatches`/`approveLiveProposal` helpers; body split into
  per-section computed properties + `ProposalApprovalRow` subview (see the
  view-body-split subsection above — required to keep the file within the
  Swift type-checker's solver budget).
- `docs/rollouts/2026-07-18-ios-client-fixes.md` (this note).

No server-side files were touched — `app/api/mobile/events/route.ts` and the
rest of the mobile API contract are unchanged, per instruction (the PWA
depends on the existing server behavior, which is already spec-conformant
SSE and a correct `assertLiveApprovalConfirmation` implementation).

## Verification

No test suite exists for `ios/SocraticTrade/` (it's plain Swift files with no
Xcode project checked in) and this session had no Xcode automation. What was
actually run:

- `swiftc -parse` on each of the six files individually (syntax only, no
  cross-file type resolution needed) — all six clean, no output.
- `swiftc -typecheck MobileModels.swift MobileAPIClient.swift MobileStore.swift MobileControlView.swift LoginView.swift SocraticTradeApp.swift`
  from `ios/SocraticTrade/`, targeting the host **macOS** SDK (SwiftUI and
  AuthenticationServices both exist on macOS too, so this typechecks real
  cross-file references — `PendingProposal`, `LiveApprovalConfirmation`,
  `MobileAPIError`, etc. — even though it isn't the iOS SDK). Three runs:
  1. **Pre-refactor:** failed after ~8.5 min with the solver-budget error
     ("unable to type-check this expression in reasonable time") at the
     Approvals `VStack` in `MobileControlView.body` — a real finding; fixed
     by the view-body split described above.
  2. **After the `ProposalApprovalRow` extraction only:** killed after ~28 min
     with no output (inconclusive — expressions can sit just under the solver's
     per-expression error budget and take minutes each), which motivated the
     full per-section split.
  3. **After the full per-section split:** completed in a few minutes, exit 1
     with **exactly three errors, all the same false positive**:
     `.textInputAutocapitalization` is an iOS-family-only SwiftUI modifier that
     does not exist on macOS. Two of the three call sites (the Watchlist ticker
     field and the account-deletion fields) are pre-existing code untouched by
     this change; the third is the new live-confirmation alert `TextField`,
     written in the same style. **No other type errors** — all the new
     cross-file references (`MobileAPIError`, `LiveApprovalConfirmation`,
     `requireTypedConfirmation`, the coalescing store logic, the alert flow)
     typecheck clean on macOS.
- `swiftc -typecheck -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)"
  -target arm64-apple-ios17.0-simulator <same six files>` — the definitive
  iOS-SDK check (which would also validate the three modifiers above) **was
  run, but its log could not be read back in this session** (a tool-permission
  denial landed at exactly that point; per instruction the read was not
  retried). **Treat simulator/iOS verification as pending the owner's Xcode
  build** — this note deliberately claims nothing about that run's contents.

Did NOT run (out of scope / unavailable here): `npm run lint` / `npx tsc
--noEmit` / `npm test` / `npm run build` — no TypeScript/JS files were
touched, so the repo's JS verify gate doesn't apply to this change. An actual
Xcode build (`Cmd-B` against a real target with the iOS SDK, entitlements, and
Info.plist) was not possible in this session.

## Follow-ups

- **Do one Xcode build** before merging/shipping this branch — see the
  untested-by-compilation caveat at the top.
- Consider whether `submit()`/`startAccountDeletion()`/`confirmAccountDeletion()`
  should also proactively route the user back to `LoginView` (not just set
  `isAuthenticated = false`, which `ContentView` already reacts to) with a
  clearer "please sign in again" affordance, versus today's generic error
  banner plus the flag flip — this rollout intentionally kept the UI reaction
  to that flag unchanged (it was already correct in `SocraticTradeApp.swift`'s
  `ContentView`) and only fixed *when* the flag flips.
  `if apiError = statusCode 401/403` -> the flag flips and `ContentView`
  already re-renders `LoginView` on the next state update, so no additional
  change was needed there, but worth a UX pass on whether a toast/explanation
  ("your session expired") should show on the login screen specifically for
  that transition versus a fresh cold start.
- The `LiveApprovalConfirmation.jsonObject` / `MobileAPIError.serverMessage`
  JSON handling was reasoned through carefully (Optional-in-`[String: Any]`
  is a known `JSONSerialization` pitfall) but, per the caveat above, has not
  been exercised against a live server response — worth a manual pass with a
  real live-brokerage proposal once buildable.
- No changes were made to `LoginView.swift` or `SocraticTradeApp.swift`; they
  were reviewed for the same latent patterns (item 32's scan requirement) and
  found not to need changes.
