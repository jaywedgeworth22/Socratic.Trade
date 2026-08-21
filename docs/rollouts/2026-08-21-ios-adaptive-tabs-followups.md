# 2026-08-21 - ios-adaptive-tabs-followups

Handoff for whoever picks this up next.  Written to be claimable in pieces — nothing here
depends on anything else here.

## 1. Context & Objective

The width-aware iOS/Mac tab bar and the iPad Air 11" layout pass **merged** to `main` as
`9298c29` (PR #2987, squash, 2026-08-21 06:56 UTC).  16 files, +1,359 / -137.

What it does, in one paragraph: `TabBarCapacity` converts the live window width into a slot
count (compact 4; iPad Air 11" 6 portrait / 8 landscape; a Mac window recomputes as it is
dragged; ceiling 8, floor 2).  Home is required and never toggleable.  The slot immediately
before More is *borrowed* — opening a screen from the More list hands it that slot, displacing
Activity by default; pinning that screen makes it permanent and gives the slot back.  A window
too narrow for the owner's chosen set renders the DEFAULTS instead and writes nothing, so
widening restores their picks exactly.  Until the owner pins or unpins anything the bar
auto-fills to what fits.  `SnapshotScaffold` picks 1/2/3 card columns from its own measured
width; **one column is the pre-existing `LazyVStack`, so the iPhone path is unchanged.**

Design detail, decisions, and the evidence table live in
`docs/rollouts/2026-08-21-ios-adaptive-tabs-ipad-layout.md`.  This note is only the open items.

## 2. What is NOT verified

The originating session ran in a Claude Code remote **Linux** container: no `xcodebuild`, no
`swiftc`, no `xcodegen`, no simulator.  So:

- **The XCTests are compiled but have never been executed.**  30 cases in
  `ios/SocraticTradeTests/TabPreferencesTests.swift` (capacity breakpoints, the Home lock,
  auto-fill, the narrow fallback, the borrowed slot) and 15 in
  `ios/SocraticTradeTests/WrappingHStackTests.swift` (`ContentColumnsTests`,
  `CardColumnsLayoutTests`, `AppMetricGridColumnsTests`).  `ios-build.yml` only ever runs
  `xcodebuild build`, never `test`, so no lane in this repo has run them.
- **There is no screenshot.**  The column breakpoints and the borrowed-slot behaviour have
  never been seen by a human.  `BUILD SUCCEEDED` is not visual QA.

The Swift itself IS proven to compile: the Mac runner printed `** BUILD SUCCEEDED **` twice on
the branch (05:22:30 and 06:21:48), and `verify` was green.

## 3. Open items

### A. Run the tests and take the screenshots  *(needs a Mac; ~20 min)*

```bash
xcodebuild test -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO

# iPad Air 11" in both orientations — this is the size the layout was designed for.
xcrun simctl list devices available | grep -i 'iPad Air'
xcrun simctl boot "iPad Air 11-inch (M3)"
xcrun simctl io booted screenshot /tmp/st-ipad-portrait.png
xcrun simctl io booted screenshot /tmp/st-ipad-landscape.png   # after rotating
```

Then check, specifically:
- Portrait 820pt should show **6 tabs + More** and **2 card columns**; landscape 1180pt should
  show **8 + More** and **3 columns**.
- Open something from More (Coach, say) and confirm it lands in the slot **immediately before
  More**, displacing Activity — and that More then carries Activity's unread badge.
- Drag a Mac Catalyst window narrow and confirm the bar falls back to the **default** tabs, and
  that widening restores the chosen set.

### B. Rename `WrappingHStackTests.swift`  *(needs a Mac, because it needs `xcodegen`)*

That file now holds every pure layout helper, not just the wrapping stack.  It could not be
split in the originating session: the checked-in `.xcodeproj` uses explicit
`PBXFileReference` entries (no synchronized folder group), so a new `.swift` file simply never
compiles until `xcodegen generate` runs.  Rename to `LayoutMathTests.swift`, run
`xcodegen generate`, then restore `objectVersion = 100` / `preferredProjectObjectVersion = 100`
in `project.pbxproj` per `ios/CLAUDE.md`.

### C. The `xcodebuild` CI check hangs on EVERY iOS PR  *(any seat; own PR)*

Not caused by #2987.  PR #2794, authored by someone else and merged to `main` at 04:35 the same
day, has the identical `cancelled` outcome (04:16:13 -> 04:51:13).

Root cause: the step never exits after `xcodebuild` returns.  Both runs on #2987 log
`Terminate orphan process: pid (SWBBuildService)` during post-job cleanup — Xcode's build
service daemon outlives `xcodebuild`, inherits the step's stdout pipe, and the Actions runner
waits on that pipe rather than on the process.  **Raising `timeout-minutes` does NOT fix this**
(attempt 2 built in 21 minutes with nine minutes of headroom and was cancelled anyway); the job
would just hang longer.

Proposed patch to `.github/workflows/ios-build.yml` — give the daemon a file to inherit instead
of the runner's pipe:

```yaml
      - name: Build SocraticTrade (generic iOS device, unsigned)
        run: |
          set -o pipefail
          log="$RUNNER_TEMP/xcodebuild.log"
          # SWBBuildService outlives xcodebuild and inherits its stdout.  Left on the runner's
          # own pipe it holds the step open until timeout-minutes kills it, even on a build
          # that already printed BUILD SUCCEEDED.  A file breaks that inheritance.
          set +e
          xcodebuild build \
            -project 'ios/Socratic Trade.xcodeproj' \
            -scheme SocraticTrade \
            -destination 'generic/platform=iOS' \
            CODE_SIGNING_ALLOWED=NO \
            CODE_SIGNING_REQUIRED=NO \
            > "$log" 2>&1 < /dev/null
          status=$?
          set -e
          tail -300 "$log"
          exit $status
```

Verify by watching one PR's job actually reach a `success` conclusion rather than `cancelled`.
Two owner calls travel with it: make `ios-build` a **required** check in the `main-protection`
ruleset (today a broken iOS build cannot block a merge — same point as board finding
`830c892f`), and add an `xcodebuild test` lane so item A stops being manual forever.

### D. `PrivacyInfo.xcprivacy` is declared but not in the bundle  *(needs a Mac)*

Pre-existing, found while merging `main` in.  `ios/project.yml` declares it as a resource
(added by PR #2794), but the checked-in `project.pbxproj` contains **zero** references to it,
and `scripts/ios-ship-testflight.sh` does not run `xcodegen`.  So the shipped TestFlight binary
does not contain the privacy manifest despite the PR that added it.  Fix is the same
`xcodegen generate` as item B — do them together.

### E. One design decision the owner may want to veto  *(no code needed to decide)*

**Auto-fill is not literally in the owner's request.**  Until the owner pins or unpins
anything, the bar fills itself to whatever the window fits.  Without it a fresh iPad still
shows four tabs and the whole feature only exists for someone who goes looking for it.  With
it, a fresh iPad Air 11" landscape shows eight tabs out of the box, which some people will
find busy.

To remove: delete `hasCustomSelection` and the `autoFill` call sites in
`TabPreferences` (`ios/SocraticTrade/MobileControlView.swift`), and update
`testFreshInstallFillsTheBarToWhateverTheWindowFits`,
`testAutoFillPutsTheDefaultsFirst`, `testTheFirstPinOrUnpinStopsTheAutoFill`, and
`testResizingAloneNeverCountsAsCustomizing`.

Also open, and genuinely the owner's: whether `AppTab.customizable`'s declaration order is the
right PRIORITY order for auto-fill.  It currently reads defaults first (Home, Proposals,
Assets, Activity) then Insights, Coach, Scan, Guardrails, Results.

### F. Tuning knobs, if the bar or the columns feel wrong

All in two places, both pure math with tests attached:

| Knob | File | Today |
|---|---|---|
| `TabBarCapacity.slotWidth` / `.reservedWidth` | `MobileControlView.swift` | 108 / 132 |
| `TabBarCapacity.maximum` / `.minimum` / `.compact` | `MobileControlView.swift` | 8 / 2 / 4 |
| `ContentColumns.twoColumnMinimum` / `.threeColumnMinimum` | `AppComponents.swift` | 680 / 1100 |
| `ContentColumns.maximumContentWidth` | `AppComponents.swift` | 1360 |
| `ContentColumns.readableWidth` / `.maximumActionWidth` | `AppComponents.swift` | 760 / 520 |
| `AppMetricGrid.minimumTileWidth` | `AppComponents.swift` | 178 (150 for Desk shortcuts) |

Changing any of them should change a test in `TabPreferencesTests` or `WrappingHStackTests`.

## 4. Decisions & Trade-offs already made (do not re-litigate without reading these)

- The narrow fallback shows the **defaults**, not a trimmed version of the owner's set.  That is
  literally what was asked for.  Consequence: with 8 pinned and a window that fits 6, the bar
  shows the 4 defaults, not 6 of the 8.
- The borrowed slot **persists** across launches.  A session-scoped slot would snap the bar back
  to Activity on every cold start.  The aggregate More badge is what makes persisting it safe.
- `.tabViewStyle(.sidebarAdaptable)` was considered and **not** adopted: it replaces More with a
  system sidebar that owns the customization affordance, which would take both the required-Home
  rule and the borrowed slot out of our hands.  Revisit only on owner instruction.
- The `Tab` blocks are **positional** (`bar[0]`…`bar[8]`) and must stay unrolled: `ForEach` +
  `Tab` times out the Swift 6 type-checker on Release/archive, and a result builder takes at
  most ten children — there are exactly ten.
- The web console was deliberately not touched.  `MOBILE_TABS_MAX` there governs a phone bottom
  bar.  iOS and web now diverge on the ceiling; the default *set* is still shared.

## 5. Verification State

- `main` `9298c29` carries the change.  `verify` green; `xcodebuild (unsigned)` `cancelled` per
  item C, which is not this change's failure.
- Nothing in item A has been run.

## 6. Blockers

- Items A, B and D need a Mac with Xcode 26 and a simulator.  A Claude Code Remote cloud session
  cannot do them — those containers are Linux and hit the identical wall.
