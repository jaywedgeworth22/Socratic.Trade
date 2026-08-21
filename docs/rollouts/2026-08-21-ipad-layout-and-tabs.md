# iPad Air 11" / Mac Catalyst layout, tab bar, and the login wordmark

2026-08-21 · CLAUDE · branch `claude/ipad-layout-login`

Owner-directed, one sitting.  Three groups of work: the login screen, the tab bar,
and a whole-app layout pass for iPad Air 11" that the Mac Catalyst window inherits.

## 1. Login

**The wordmark was frozen, and the cause was the schedule, not the drawing.**
`TimelineView(.periodic(from: .now, by: 1.0))` anchors its phase to the `.now` captured
when the schedule is built, and SwiftUI rebuilds that schedule every time the body is
re-evaluated.  Inside a `ScrollView` that is constant, so the next entry kept being pushed
a second into the future and the mark sat on one frame indefinitely.  The web `HeaderLogo`
(`app/console/ui/candle-ticker.ts` + `header-logo.tsx`) drives the same integer tick off
`requestAnimationFrame` and has no such anchor — which is exactly why the site moved and
the app did not.  Now on the display-link-backed `.animation(minimumInterval:paused:)`
schedule with a `@State` start date.

The same defect existed in `SnapshotScaffold`'s 30-second tick, which is what refreshes
"updated N seconds ago"; fixed with a `@State` anchor.

Also: wordmark at 80% of the content column, "strategic" dropped from the first value
bullet (and from the web `LOGIN_VALUE_BULLETS` it is kept in sync with), and the lock line
plus the disclaimer merged into ONE justified paragraph sitting to the right of the lock,
which hangs into the column gutter so the text keeps full width.  "Socratic Trade" removed
before "session".  New shared `JustifiedText`, because SwiftUI has no justified case —
`TextAlignment` is leading/center/trailing and `Text` ignores an `NSParagraphStyle`.

## 2. Tab bar

- **Home is required.**  Cannot be unpinned; a stored set that omits it is repaired on load.
- **The slot before More swaps.**  Bar = pins in canonical order, then ONE flex slot, then
  More.  Activity starts in the slot.  Opening a screen from More that has no tab moves it
  into the slot instead of pushing it inside More, where it had no tab and no way back.
  More became a launcher; `morePath` is gone.
- **The bar grows with the window.**  Capacity from live width via `onGeometryChange`: 4 on
  a phone, up to 7 on a wide iPad or full-screen Mac window, and back down as a Catalyst
  window narrows.  Too narrow for the owner's pins falls back to the DEFAULT pins without
  forgetting them.

Two holes closed that the naive version would have shipped: the narrow fallback keeps the
flex slot (dropping it would leave `selectedTab` pointing at a `Tab` the TabView no longer
renders — an empty pane), and `ensureVisible` parks a PINNED tab the owner is looking at
when the window narrows, without touching its pin.

Storage moves to `mobileTabs.stable.v2` + `mobileTabs.flex.v2`, migrating the v1 flat list
by treating its last canonical entry as the flex occupant, so an existing install's bar
looks identical after the upgrade.

## 3. Layout

A 72-agent audit (9 screens, adversarially verified) returned 58 confirmed findings that
all reduced to one keystone: `SnapshotScaffold` padded a flat 16pt and let its LazyVStack
take whatever width it was given.  Correct at 393pt, absurd at 1180pt — every card on eight
of the nine tabs was a 1148pt letterbox.

`AppLayout` records the three rules and why each is safe:

- **R1** a plain `maxWidth` ceiling needs no size-class gate; it resolves to
  `min(ceiling, proposal)` and the widest content an iPhone in this app proposes is ~408pt.
- **R2** a structural branch on `horizontalSizeClass` is provably unreachable on iPhone,
  because the phone is portrait-locked (`project.yml UISupportedInterfaceOrientations`).
- **R3** anything tracking a RESIZED Catalyst window measures its own width, because
  Catalyst reports `.regular` at every size and a sheet inherits the WINDOW's traits.

Shipped: one content column inherited by eight tabs; `.large` titles at regular width
(Coach and every sheet deliberately excepted); six metric grids that pack to their measured
width; adaptive card grids on Proposals / Markets / Activity / Results / Insights; Home's
cards paired into two measured columns and its Agent Controls ladder turned into a rail
beside its legend; `presentationSizing(.page)` on the symbol sheet.

Two fixes that were not on the original list:

- **Confirmation dialogs now point at the right card.**  They were attached to the row root,
  and on iPad/Catalyst that presents as a popover anchored to whatever it is attached to.
  With cards side by side in a grid there was no way to tell WHICH order was about to be
  cancelled, on an irreversible broker action.
- **Swipe actions no longer lie to VoiceOver.**  Disabling the swipe at regular width
  exposed a latent bug: `SwipeRevealAction` advertised its rotor action unconditionally with
  a `guard isEnabled` inside, plus a hint promising a gesture that was off.

## What the tests caught

`AppLayoutTests` and `CandleWordmarkTests` were written, but a new source file needs a
pbxproj entry — they had been compiling and running nowhere.  Regenerated with the project's
own `xcodegen` and re-applied `objectVersion`/`preferredProjectObjectVersion` 100 per the
warning at the top of `project.yml`; the pbxproj diff is 8 lines, exactly the two entries.

Once they ran, `AppLayoutTests` failed immediately on a REAL iPhone regression: the audited
plan set `AppLayout.action` to 360, but solitary CTAs live inside an `AppCard` whose interior
on a 440pt Pro Max is ~376pt — so the ceiling BOUND there and quietly narrowed Run Once /
Start / Stop by 16pt.  Raised to 420.  A ceiling meant to be invisible on iPhone has to clear
the CARD INTERIOR, not the screen width.

## Gate

`xcodebuild build` clean, **199 tests, 0 failures**.

Run on the **Mac Catalyst** destination, not the simulator: `simdiskimaged` on this Mac is
wedged (every `simctl` call blocks in `SimDiskImageManager kickstartServiceWithError:`, and
simulator boot times out after 60s).  It is root-owned, so restarting it needs the owner:

```
sudo launchctl kickstart -k system/com.apple.CoreSimulator.simdiskimaged
```

or a reboot.  **Consequence: this change has NOT been visually verified.**  Every claim about
iPhone being unchanged is argued from arithmetic (`min(ceiling, ≤408pt)`) and from the
portrait lock, and the tests pin both — but no screenshot has been taken on any device.  The
screenshot gate (iPhone portrait, iPad Air landscape + portrait, Catalyst at ~800pt and full
screen) is still owed.
