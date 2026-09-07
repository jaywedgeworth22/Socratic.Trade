# 2026-09-07 — iOS hard-crash fix: `Dictionary(uniqueKeysWithValues:)` on duplicate server command ids

## Context & Objective

P1 hard crash (board `3b3df6ca`, duplicate of `d9f81e44`, originally flagged in the
2026-08-20 DeepSeek full-stack review).  `CommandAttemptTracker.reconcile(_:)`
(`ios/SocraticTrade/MobileStore.swift:46`) built its id→command lookup with
`Dictionary(uniqueKeysWithValues: commands.map { ($0.id, $0) })`.  That initializer
calls `fatalError` — not a catchable Swift error — the instant the input sequence
contains two entries with the same key.  The server can legitimately report the same
`MobileCommand.id` twice in one `recentCommands` snapshot (e.g. overlapping poll
windows), so this was a reachable crash on real production data, not a theoretical one.

Goal: eliminate the trap without changing observable behavior for the common
(non-duplicate) case, pick a deliberate and documented collision policy, surface real
duplicates instead of silently dropping them, and add a regression test.

## Investigation

`grep -rn "uniqueKeysWithValues" --include="*.swift" .` from the repo root found
exactly one call site: `ios/SocraticTrade/MobileStore.swift:46`.  No other
`Dictionary(uniqueKeysWithValues:)` usage exists anywhere in the iOS app or test
target, so no other call site needed the same treatment or a "provably unique keys"
judgment call.

## Changes Made

- `ios/SocraticTrade/MobileStore.swift`
  - `import Sentry` added (already a linked SPM dependency via `SentryTelemetry.swift`;
    this is the only telemetry/logging facility present anywhere in the iOS app — there
    is no `os.Logger` / `OSLog` / custom `AppLogger` in the codebase to reuse instead).
  - `CommandAttemptTracker.reconcile(_:)`: replaced the trapping initializer with
    `Dictionary(_:uniquingKeysWith:)`. Policy: **last-wins by `updatedAt`** — ISO8601
    timestamp strings sort lexicographically, so comparing them directly picks the
    entry with the more recent server-reported update regardless of the two entries'
    relative position in the input array. This is intentionally more robust than a
    plain "last element in the array wins" rule, since the array's ordering guarantee
    from the server is not documented anywhere in the codebase.
  - On an actual collision, the duplicate command id is recorded and reported via
    `SentrySDK.capture(message:)` at `.warning` level (count only, no raw command
    ids/payloads) — a duplicate here means the server sent inconsistent data, which is
    worth knowing about rather than swallowing.
- `ios/SocraticTradeTests/MobileModelsTests.swift`
  - New test `testReconcileDoesNotCrashOnDuplicateCommandIdsAndKeepsTheFreshestByUpdatedAt`:
    feeds `reconcile([fresh, staleDuplicate])` where both share id `command-9`, with
    the *stale* (earlier `updatedAt`) entry deliberately listed **after** the fresh one
    in the array. Asserts the call does not crash and that the resolution reflects the
    fresher entry (`status: "failed"`) — proving the winner is chosen by `updatedAt`,
    not by array position.

## Decisions & Trade-offs

- Last-wins by `updatedAt`, not first-wins: a duplicate id most plausibly represents
  the same underlying command observed at two different points in its lifecycle (e.g.
  one page of a poll captured it mid-flight, a later fetch shows it terminal). The
  freshest status is the one the tracker's terminal-state resolution logic
  (`command.isTerminal`) needs to see.
- Comparison key is `updatedAt` (a `String` field on `MobileCommand`, ISO8601,
  server-generated), not array index — avoids depending on an undocumented ordering
  contract from the `/api/mobile` snapshot endpoint.
- Sentry (`SentrySDK.capture(message:)`) was chosen over `print`/`NSLog` because it is
  the only telemetry facility integrated into the iOS app at all (`SentryTelemetry.swift`);
  no other logging convention exists in this file or module to defer to. Level
  `.warning`, message text only (id count, not raw ids or payload) to stay consistent
  with the app's existing PII-conscious Sentry configuration (`sendDefaultPii = false`,
  URL param redaction in `beforeSend`).
- No other call sites existed to leave alone or change — this is the sole trapping
  initializer in the codebase.

## Verification State

This Mac has **no iOS Simulator runtime installed** — `xcrun simctl list runtimes`
returns an empty list, and `xcodebuild -destination "generic/platform=iOS Simulator"`
confirms the destination is unavailable. This is a pre-existing environment gap noted
by a prior session, not something this change caused. A real device/simulator run was
therefore not possible; the following is the closest available compile+test
verification, using the identical Swift sources.

```bash
xcodebuild -project "Socratic Trade.xcodeproj" -scheme "SocraticTrade" \
  -destination "platform=macOS,variant=Mac Catalyst" build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO
# ** BUILD SUCCEEDED **

xcodebuild -project "Socratic Trade.xcodeproj" -scheme "SocraticTrade" \
  -destination "platform=macOS,variant=Mac Catalyst" test \
  CODE_SIGNING_ALLOWED=NO CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO \
  -only-testing:SocraticTradeTests/MobileModelsTests
# Executed 31 tests, with 0 failures (0 unexpected)
# ** TEST SUCCEEDED **
```

Web/backend `verify` and `gitleaks` are the required GitHub checks for merge; this
change touches only `ios/` and docs, so those checks are expected to be unaffected
no-ops for the app code, but they still must pass per branch protection.

## Next Steps & Blockers

- **Merging to `main` does NOT ship this fix to users.** The iOS app is distributed
  separately via TestFlight/App Store; this change reaches real devices only on the
  next iOS release build and submission, not on merge/deploy of `main`.
- No Coolify mutate. No extra-ship beyond this PR.
- Board `3b3df6ca` (duplicate `d9f81e44`) to be updated to reflect PR + merge status.
