# 2026-08-21 - ios-adaptive-tabs-ipad-layout

## 1. Context & Objective

Owner ask, verbatim: *"enable showing more than 4 menu tabs on iPads and when window is
wider on a Mac.  If it gets too narrow for the options chosen then just change back to the
default ones then (if window resized smaller I mean).  lets make the Home tab required and
the tab right before "More" (Activity by default) be swapped out with other options whenever
a tab from More list is chosen that isn't among the prior 3+ tabs (Home plus 2 more on iOS
which are followed by Activity - which will be replaced when any section is navigated to that
doesn't have a tab).  also, have some UI experts make the layout actually nicer for iPad Air
11" size in all other ways too and ensure Mac app gets those benefits where possible."*

The iOS app (which is also the Mac Catalyst app — `TARGETED_DEVICE_FAMILY "1,2,6"`,
`SUPPORTS_MACCATALYST: YES`) had a hard four-tab ceiling inherited from the web console's
phone bar, and **zero** size-class adaptation anywhere: a grep for `horizontalSizeClass`,
`userInterfaceIdiom`, or any width branch across `ios/SocraticTrade/**` returned nothing
before this change.  Every screen rendered one phone-width column stretched edge to edge,
which on an iPad Air 11" landscape (1180pt) and on a Mac window meant 1100pt-wide buttons and
single-file cards with nothing beside them.

## 2. Changes Made

### A. The tab bar is width-aware (`MobileControlView.swift`)

**`TabBarCapacity`** — new pure enum, no SwiftUI, so XCTest can pin the breakpoints:

```
fits(width:isRegularWidth:) = clamp(floor((width - 132) / 108), 2, 8)   // regular width
                            = 4                                         // compact width
```

| Window | Slots beside More |
|---|---|
| Any compact width (every iPhone; an iPad in Slide Over) | 4 |
| iPad Air 11" portrait, 820pt | 6 |
| iPad Air 11" landscape, 1180pt | 8 (the ceiling) |
| Mac window 900pt / 700pt / 500pt / 200pt | 7 / 5 / 3 / 2 |
| Width not measured yet (0, or non-finite) | 4 |

`isRegularWidth` is `horizontalSizeClass == .regular && idiom != .phone`.  The idiom half is
belt-and-braces: `Info.plist` pins iPhone to portrait, but a Max-class iPhone in landscape
reports `.regular` and must never grow the bar.

**Home is required.**  `TabPreferences.requiredTab = .home`; `canToggle(.home)` is always
false, `toggle(.home)` is a no-op, and a stored selection that somehow lacks Home has it
inserted at index 0 on load.  The More row shows a disabled pin with its own accessibility
label ("Home is always on the tab bar") rather than the misleading "Remove Home from tab bar".

**The slot before More is borrowed, not owned.**  `dynamicTab` holds whichever screen the
owner last opened that is not on the bar.  `resolve(barTabs:dynamicTab:capacity:)` drops the
LAST entry of the resolved bar and appends the borrowed one, so it always renders in the slot
immediately before More and Home is never the one displaced.  It is set by `promote(_:)`,
which is a no-op for anything already visible — so tapping a real tab never disturbs it.

**Narrow fallback.**  If the owner's chosen membership does not fit, the bar renders
`defaultTabs` trimmed to what fits instead.  **Nothing is written to storage**, so widening
the window restores their exact choice.  `testFallbackDoesNotTouchTheStoredChoice` pins both
halves of that.

**Auto-fill before any preference exists.**  A fresh install has no stored array, so the bar
fills itself to `capacity` (defaults first, then the remaining screens in canonical order).
That is what actually delivers "more than 4 tabs on iPad" out of the box — without it an iPad
would still show four until the owner went and pinned more by hand.  The first pin or unpin
sets `hasCustomSelection` and freezes their set; resizing alone never counts as customizing.

**More gets an aggregate badge** for the unread counts of every screen not currently on the
bar, so a displaced Activity's unread count is never invisible.

**The `Tab` blocks are now positional** — `bar[0]` … `bar[8]` — instead of one fixed block per
screen.  That is what lets the borrowed occupant render last.  Two hard constraints held:
the blocks stay unrolled (the file already documents that `ForEach` + `Tab` times out the
Swift 6 type-checker on Release/archive), and there are exactly ten children because a result
builder takes no more.

**More rows now open a tab instead of pushing a stack.**  `morePath` /
`navigationDestination(for: AppTab.self)` are gone: tapping a row calls `promote` and selects
it, which is precisely the owner's "swapped out … whenever a tab from More list is chosen".

### B. iPad Air 11" / Mac layout (`AppComponents.swift` + per-screen)

- **`ContentColumns`** — breakpoints on the CARD AREA (scroll width, clamped, less padding):
  `>= 1100` → 3 columns, `>= 680` → 2, else 1; compact width is always 1.  Card area is
  clamped to 1360pt so a large Mac window keeps margins instead of 1900pt-wide cards.
  iPad Air 11" portrait (788pt card area) → 2 columns of 387pt; landscape (1148pt) → 3 columns
  of 373pt.  `testEveryColumnStaysWiderThanAPhoneCard` asserts no column is ever narrower than
  the ~358pt a phone already gets — splitting into columns must not make anything harder to
  read.
- **`CardColumns`** — a `Layout` that drops each card into the shortest column; ties stay left
  so reading order survives.  `.cardSpansAllColumns()` (a `LayoutValueKey`) keeps the
  freshness banner and each screen's hero full width and starts a fresh row.  Math lives in
  `CardColumnsLayout`, the same view/math split `WrappingHStack` already uses.
- **`SnapshotScaffold`** measures itself with `onGeometryChange` and picks the branch.
  **One column is the existing `LazyVStack`, byte-identical**, so no iPhone rendering or
  laziness changes; the `Layout` path is only ever reached at regular width.
- **`AppMetricGrid`** replaces all six hardcoded `[GridItem(.flexible()), GridItem(.flexible())]`
  grids.  It measures **its own** width, not the screen's, which is the point: the same card
  holds two tiles in a column and four when it spans.  It answers 2 before measurement and 2
  at phone width, so the iPhone renders exactly what it did.
- **Coach** is one conversation, not a wall of cards — transcript, draft card, and composer
  keep a 760pt readable measure and centre.
- **The Home hero's primary action** is capped at 520pt and centred instead of being drawn a
  full window wide.  The cap never binds on a phone.

### Files touched

- `ios/SocraticTrade/MobileControlView.swift` — `TabBarCapacity`, `TabPreferences` rewrite,
  positional tabs, `MoreView` rows open tabs.
- `ios/SocraticTrade/AppComponents.swift` — `ContentColumns`, `CardSpanKey`,
  `cardSpansAllColumns()`, `CardColumns`, `CardColumnsLayout`, `AppMetricGrid`,
  `AppMetricGridColumns`, adaptive `SnapshotScaffold`.
- `ios/SocraticTrade/HomeView.swift` — hero spans, CTA capped, two grids adapted.
- `ios/SocraticTrade/ActivityView.swift`, `ResultsView.swift`, `SymbolInfoSheet.swift` — grids adapted.
- `ios/SocraticTrade/InsightsView.swift`, `ProposalsView.swift`, `ScanView.swift` — heroes span.
- `ios/SocraticTrade/CoachView.swift` — readable measure.
- `ios/SocraticTradeTests/TabPreferencesTests.swift` — rewritten, 30 cases.
- `ios/SocraticTradeTests/WrappingHStackTests.swift` — plus `ContentColumnsTests`,
  `CardColumnsLayoutTests`, `AppMetricGridColumnsTests`.

## 3. Decisions & Trade-offs

- **Ceiling of 8, not 9.**  Past eight a tab bar stops being a bar.  Results is the one screen
  that cannot be auto-filled onto a maximal bar; it is one tap away in More.
- **The narrow fallback shows the DEFAULTS, not a trimmed version of the owner's set.**  That
  is literally what the owner asked for, and it is the more predictable rule.  Consequence
  worth knowing: with 8 pinned and a window that fits 6, the bar shows the 4 defaults rather
  than 6 of the 8.
- **The borrowed slot persists across launches.**  A session-scoped slot would snap the bar
  back to Activity on every cold start.  The aggregate More badge is what makes persisting it
  safe — a displaced Activity's unread count stays visible.
- **`.tabViewStyle(.sidebarAdaptable)` was considered and NOT adopted.**  It would replace More
  with a system sidebar, which owns the customization affordance and would take both the
  required-Home rule and the borrowed slot out of our hands.  Revisit only on owner
  instruction.
- **Branching `LazyVStack` vs `CardColumns` rather than always using the `Layout`.**  A `Layout`
  realizes every subview eagerly.  Branching keeps the iPhone path untouched at the cost of a
  view-identity flip when a Mac window crosses 680pt (cards rebuild; card-local `@State` such
  as an in-flight acknowledge highlight resets).  Cosmetic, iPad/Mac only.
- **New test files were NOT added.**  `ios/Socratic Trade.xcodeproj` uses explicit
  `PBXFileReference` entries (no synchronized folder group), CI builds the checked-in project,
  and `xcodegen` cannot run on this Linux container — a new `.swift` file would simply never
  compile.  The layout-math tests therefore live in `WrappingHStackTests.swift`, which is
  documented at the top of the file as "all pure layout math".  See Follow-ups.
- **The web console was deliberately not touched.**  `MOBILE_TABS_MAX` there governs a phone
  bottom bar; the owner's ask was about iPad and Mac.  iOS and web now diverge on the tab
  ceiling, and the comments in `TabPreferences` no longer claim min/max parity with
  `app/console/lib/mobile-tabs.ts` (the default SET is still shared).

## 4. Verification State

```
python3  brace/paren/bracket balance scan over ios/**/*.swift   -> clean
```

**Nothing else could be run here, and this is the important caveat.**  This is a Claude Code
remote Linux container: there is no `xcodebuild`, no `swiftc`, no `xcodegen`, and no
simulator, so **no Swift in this change has been compiled and no screenshot exists.**  The
repo's own four-command gate (`lint` / `tsc` / `vitest` / `next build`) compiles no Swift
either and is irrelevant to a change that touches only `ios/**` — running it would prove
nothing, which is exactly the trap `AGENTS.md` warns about.

The first real compile is `.github/workflows/ios-build.yml` on the Mac runner
(`mac-xcode26-socratic`), which runs on every PR touching `ios/**`.  Treat its result as the
verification of record for this change and drive it to green.

## 5. Next Steps & Blockers

1. **Watch `iOS build (Mac runner)` on the PR** and fix whatever it reports.  Highest-risk
   spots, in order: the `let tab = bar[i]` declaration inside the `TabContentBuilder` `if`
   blocks; `CardColumns`' `Layout` conformance; `onGeometryChange` on the `TabView`.
2. **On a Mac session:** take the screenshots this container cannot.  iPad Air 11" simulator
   in both orientations, plus a Mac window dragged from wide to narrow, per the fleet rule
   that `BUILD SUCCEEDED` is not visual QA.
3. **On a Mac session:** rename `WrappingHStackTests.swift` to something like
   `LayoutMathTests.swift` and run `xcodegen generate` (then restore `objectVersion = 100`),
   so the file name matches what it now covers.
4. **Owner call, not taken here:** whether `AppTab.customizable`'s declaration order is the
   right PRIORITY order for auto-fill.  It currently reads defaults first
   (Home, Proposals, Assets, Activity) then Insights, Coach, Scan, Guardrails, Results.
5. **Tuning knobs, all in one place if the bar or columns feel wrong:**
   `TabBarCapacity.slotWidth` / `.reservedWidth` / `.maximum`, and
   `ContentColumns.twoColumnMinimum` / `.threeColumnMinimum` / `.maximumContentWidth`.

## 6. Blockers

- No Swift toolchain in this environment (see Verification State).  Not a blocker on landing
  the branch, but it is a blocker on claiming the change builds.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (the branch-neutral live board) does not exist in
  this container.  Only the repo mirror `docs/EFFORT-LOG.md` could be updated; the live board
  needs the same row added from a Mac session.
