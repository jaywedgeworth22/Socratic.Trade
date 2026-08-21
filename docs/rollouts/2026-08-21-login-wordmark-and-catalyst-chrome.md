# Login wordmark, justified legal copy, and two Catalyst-only defects

2026-08-21 · CLAUDE · branch `claude/login-wordmark-catalyst`

## Why this is small

The owner's ask covered the login screen AND a width-aware tab bar AND an iPad Air layout
pass.  While that was in flight, **PR #2987 landed the tab bar and the layout pass** from the
same verbatim prompt.  Everything this branch would have duplicated has been dropped rather
than merged over the top — see "What was dropped".  What remains is the part #2987 never
touched: the login screen, and two defects that only show up on Mac.

## 1. The wordmark was frozen

`TimelineView(.periodic(from: .now, by: 1.0))` anchors its phase to the `.now` captured when
the schedule is built, and SwiftUI rebuilds that schedule every time the body is
re-evaluated.  Inside a `ScrollView` that is constant, so the next entry kept being pushed a
second into the future and the mark sat on one frame indefinitely.  The web `HeaderLogo`
drives the same integer tick off `requestAnimationFrame` and has no such anchor — which is
exactly why the site moved and the app did not.

Now on the display-link-backed `.animation(minimumInterval:paused:)` schedule with a `@State`
start date.

**The same defect is in `SnapshotScaffold`** (`.periodic(from: .now, by: 30)`), which is what
drives the "updated N seconds ago" line on every tab.  Fixed with a `@State` anchor.  It
survived #2987 because that PR rewrote the scaffold's layout, not its schedule.

## 2. Login copy and shape

- Wordmark at 80% of the content column (owner: 20% smaller).
- "strategic" dropped from the first value bullet, in the app and in the web
  `LOGIN_VALUE_BULLETS` it is kept in sync with.
- The lock line and the disclaimer are ONE justified paragraph now, sitting to the right of
  the lock, which hangs into the column gutter so the text keeps full width.  Every line lands
  on the same right edge; the last line is left alone.  "Socratic Trade" removed before
  "session".
- New shared `JustifiedText`: SwiftUI has no justified case — `TextAlignment` is
  leading/center/trailing and `Text` ignores an `NSParagraphStyle` on an `AttributedString`.
- The column vertically centres on anything taller than it needs.

## 3. Two defects the Mac app made visible

Found by building the Catalyst app and capturing its own window, which is the only visual
verification available while this Mac's iOS simulator is wedged.

- **The login screen was wearing the signed-in chrome.**  `ContentView` held both screens
  permanently and switched with `.opacity`.  That is invisible on iOS, but a TabView's bar and
  a NavigationStack's title are promoted into the WINDOW's chrome on Catalyst, which an
  opacity modifier inside the scene never reaches — so the Mac login screen had a live
  "Home · Proposals · Assets · Activity · More" bar across it and "Home" in the title bar, for
  an app you were not signed in to.  It also left the login wordmark's TimelineView ticking
  behind the whole app all session.  Both screens are built conditionally now.  The deep-link
  guarantee still holds: `pendingDeepLink` lives in `ContentView`, so a link arriving before
  sign-in survives and the shell applies it from `onAppear`.
- **The justified paragraph had rivers, and they were mine.**  Written first as a `"""`
  literal with `\` continuations, whose stripped indentation survived into the string as
  nine-space runs that justification then stretched mid-sentence.  Explicit concatenation now.

## 4. Two small fixes carried over

- **`SwipeRevealAction` was lying to VoiceOver.**  It attached its rotor action
  unconditionally with a `guard isEnabled` INSIDE, plus an unconditional hint promising a
  swipe.  A row whose action is disabled therefore advertised a "Cancel Order" that silently
  did nothing.  `accessibilityAction(named:)` has no conditional form; `accessibilityActions`
  does.
- **`SymbolInfoSheet` gets `.presentationSizing(.page)`** — a default sheet is a ~540pt
  keyhole on iPad for a nine-card screen.  Documented as inert in compact width.

## What was dropped, and why

Superseded by #2987, which landed first and in several respects went further (auto-fill to
capacity on a fresh install, an aggregate More badge, a three-column `CardColumns` masonry):

- the whole `TabPreferences` / `MobileControlView` rewrite and its tests
- `AppLayout` + the content column, `appScreenTitle`, `AppMetricGrid`, `AppCardGrid`,
  `AppSplitColumns`, and every per-screen adoption of them (Home, Proposals, Markets,
  Activity, Results, Insights)

Not re-applied here even though #2987 did not touch it: the Markets confirmation-dialog
re-anchoring.  It was worth doing when cards sat in a wide grid; on main the scaffold's
columns are ~373pt, so a row-anchored popover is already reasonably precise, and it is not
worth widening this PR for.  Filed as a follow-up instead.

## Gate

216 tests.  The single failure is `AgentControlPlanTests.testLiquidatingHidesWindDownAndKeepsCloseOnly`,
which **fails on clean `origin/main`** and is unrelated to this branch — it is corrected in
PR #3007.

Run on the **Mac Catalyst** destination: `simdiskimaged` on this Mac is wedged and
root-owned, so `simctl` blocks and simulator boot times out.  Fix is
`sudo launchctl kickstart -k system/com.apple.CoreSimulator.simdiskimaged` or a reboot.

Verified visually on the Mac.  **iPhone and iPad screenshots are still owed.**
