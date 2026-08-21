# 2026-08-21 - ios-adaptive-tabs-mac-qa (GROK, local Mac)

Paste-ready brief for a **local Grok** seat.  Cursor Cloud / Cursor local cannot take
the iPad and Mac-window screenshots.  Do this on the Mac.  Do not work in the
main integration tree.

## 0. Read this first

You are picking up **item A visual QA only** (plus babysitting PR #3027 if it is
still open).  Do **not** redo items B/C/D.  Do **not** change auto-fill (item E)
or knobs (item F) unless the screenshots prove they are wrong, and even then
ask the owner first.

Canonical leftovers: `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md`.
Tab-bar design: `docs/rollouts/2026-08-21-ios-adaptive-tabs-ipad-layout.md`.
Rename + Mac xcodegen: `docs/rollouts/2026-08-21-ios-layout-math-tests-rename.md`.

## 1. Seat / tree

```bash
# NEVER edit in ~/Code/Socratic.Trade or any main integration worktree.
cd ~/apps/trading-grok   # or: git worktree add ~/apps/trading-grok-tabs origin/main
git fetch origin
git status               # stop if dirty; do not clobber another seat
```

If PR #3027 is still open, work from that branch so you have `LayoutMathTests.swift`
and the generated pbxproj:

```bash
git checkout -B grok/ios-adaptive-tabs-mac-qa-3110 origin/cursor/ios-layout-math-tests-rename-3110
```

If #3027 has already squash-merged, start from `origin/main` on your own
`grok/ios-adaptive-tabs-mac-qa` branch.

```bash
git config user.email   # must be 12656028+jaywedgeworth22@users.noreply.github.com
bash scripts/slack-sync.sh post "repo: Socratic.Trade | [GROK] taking adaptive-tabs item A screenshots (iPad Air 11 + Mac window).  Not touching E/F.  #3027 babysit if still open."
```

## 2. Babysit PR #3027 if still open

https://github.com/jaywedgeworth22/Socratic.Trade/pull/3027
Branch: `cursor/ios-layout-math-tests-rename-3110`  HEAD was `6e685a1e`.
Auto-merge is already armed (`--squash --auto`).

The six greens you may see (gitleaks, xcodebuild, pin, auto-merge helpers) are
**not** the merge gate.  The required check is **`verify`**.  As of 2026-08-21
22:56Z:

- `verify-hosted` on the *first* SHA `3b444c23` was still in `npm test`
  (run 32534166360).
- HEAD `verify` run 32534748893 was **queued** behind it
  (`cancel-in-progress: false`).

```bash
gh pr view 3027 --json state,mergeStateStatus,autoMergeRequest,statusCheckRollup
gh run watch 32534748893 --exit-status    # HEAD verify; wait until this is success
# If that run vanished, find the CI run whose headSha is the PR head:
gh run list --branch cursor/ios-layout-math-tests-rename-3110 --workflow=CI --limit 5
```

When HEAD `verify` is green, leave it.  Auto-merge should squash.  If it is
green and still open:

```bash
gh pr merge 3027 --squash --auto    # already armed; this is a no-op if so
```

Do **not** `--admin`.  Do **not** rebase/force-push #3027.  Do **not** land
from the main integration worktree.

## 3. What is already done (do not redo)

| Item | State | Proof |
|---|---|---|
| Tab bar + iPad layout | on `main` | #2987 squash `9298c29` |
| C hang + XCTest lane | on `main` | #3023 `7ba178e1`, Mac 32529663287, 232/0 |
| A tests | on `main` | same job; 30 `TabPreferencesTests` |
| D PrivacyInfo in bundle | on `main` | #3012 `c614391c` + vitest |
| B rename to `LayoutMathTests.swift` | #3027 | Mac 32534166394 generated pbxproj; class names unchanged |

## 4. Screenshots (the actual job)

`BUILD SUCCEEDED` is not visual QA.  A screenshot of the **login** screen is
useless.  DEBUG already has a preview store:

- launch arg `-ASCScreenshots`
- or env `ASC_SCREENSHOTS=1`
- see `SocraticTradeApp.isScreenshotMode` -> `MobileStore.preview`

That is how you see the tab bar without signing in.  Do not mint keys.  Do not
put credentials in the transcript.

### 4a. Build and install on iPad Air 11"

Discover the exact simulator name first (do not invent one):

```bash
xcrun simctl list devices available | grep -i 'iPad Air'
# Expected-ish: iPad Air 11-inch (M3).  Use whatever 11-inch Air is actually there.
```

```bash
IPAD='iPad Air 11-inch (M3)'   # replace with the name from the list
cd /path/to/this/worktree

xcodebuild build \
  -project 'ios/Socratic Trade.xcodeproj' \
  -scheme SocraticTrade \
  -destination "platform=iOS Simulator,name=$IPAD" \
  -derivedDataPath /tmp/st-tabs-dd \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO

xcrun simctl boot "$IPAD" || true
xcrun simctl bootstatus "$IPAD" -b
APP=$(find /tmp/st-tabs-dd -name 'Socratic Trade.app' -path '*Debug-iphonesimulator*' | head -1)
echo "APP=$APP"
xcrun simctl install booted "$APP"
xcrun simctl terminate booted trade.socratic.app || true
xcrun simctl launch booted trade.socratic.app -ASCScreenshots
sleep 3
```

Portrait (~820 pt): expect **6 tabs + More** and **2 card columns**.

```bash
mkdir -p /tmp/st-adaptive-tabs
xcrun simctl io booted screenshot /tmp/st-adaptive-tabs/ipad-11-portrait-home.png
```

Rotate, then landscape (~1180 pt): expect **8 tabs + More** and **3 columns**.

```bash
# Rotate in the Simulator app (Device > Rotate) if simctl has no orientation verb
# on this Xcode.  Then:
xcrun simctl io booted screenshot /tmp/st-adaptive-tabs/ipad-11-landscape-home.png
```

### 4b. Borrowed slot

Still in `-ASCScreenshots` on the iPad:

1. Open **More**.
2. Open **Coach** (or any unpinned screen).
3. Confirm it occupies the slot **immediately before More** (displaces Activity
   by default).
4. Confirm More's badge still covers Activity's unread count.

```bash
xcrun simctl io booted screenshot /tmp/st-adaptive-tabs/ipad-borrowed-slot-coach.png
```

Pin that screen and confirm the slot is given back (Coach stays, Activity
returns to More or the bar per the model).  Screenshot that too.

### 4c. Mac Catalyst window drag

```bash
xcodebuild build \
  -project 'ios/Socratic Trade.xcodeproj' \
  -scheme SocraticTrade \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath /tmp/st-tabs-mac-dd \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```

Launch the built Mac Catalyst app with `-ASCScreenshots`.  Drag the window from
wide to narrow:

- Too narrow for the chosen set: bar shows the **DEFAULT** four
  (Home, Proposals, Assets, Activity), and must **not** write the stored picks.
- Widen: the owner's / auto-fill set comes back.

```bash
# After you have the window where you want it:
screencapture -w /tmp/st-adaptive-tabs/mac-wide.png
screencapture -w /tmp/st-adaptive-tabs/mac-narrow-defaults.png
```

### 4d. What "done" looks like

Four shots minimum, all light theme:

1. iPad Air 11" portrait Home — 6 + More, 2 columns
2. iPad Air 11" landscape Home — 8 + More, 3 columns
3. Borrowed slot (Coach before More)
4. Mac narrow fallback to defaults (plus the wide shot if you have it)

Put the files in the rollout note as paths.  Comment them on PR #3027 (or a
new PR if #3027 already merged) so the owner can see them.  Fleet rule: do not
claim visual QA from `BUILD SUCCEEDED`.

## 5. Do not do these

- Do not work in `~/Code/Socratic.Trade`.
- Do not hand-edit `project.pbxproj` / entitlements / xibs.  `project.yml` then
  `xcodegen generate`, then restore `objectVersion = 100` if it emitted 77.
- Do not delete `hasCustomSelection` / auto-fill (item E) unless the owner
  vetoes after seeing the landscape "8 tabs" shot.
- Do not retune `TabBarCapacity` / `ContentColumns` knobs (item F) unless a
  shot shows overflow or sparse empty chrome.
- Do not make `ios-build` a required check (board `830c892f`) — ruleset / owner.
- Do not ship TestFlight, HOTFIX, or bounce Coolify.  `ios/**` is outside
  `watch_paths`.
- Do not mint provider keys.
- Do not start Cursor Remote Control / private workers.

## 6. Close-out

Update in the same change:

1. `STATUS.md` — screenshots taken, what they showed, any veto for E/F.
2. `docs/EFFORT-LOG.md` — move the leftovers row; do not delete other rows.
3. This file + `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md` item A.
4. `PLAN.md` one-liner.
5. Slack: `repo: Socratic.Trade | [GROK] item A shots at /tmp/st-adaptive-tabs; E/F left for owner.`
6. Apple Note title `[ST, Grok] adaptive tabs visual QA`.

Gate if you touch code (you should not need to):

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

If you only add docs + attach shots, still run `npx tsc --noEmit` and the
privacy vitest (`npx vitest run test/ios-privacy-manifest.test.ts`).  Swift
proof is the Mac `xcodebuild` / Simulator, not the JS gate.
