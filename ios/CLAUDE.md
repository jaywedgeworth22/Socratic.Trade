# Socratic.Trade iOS

**Bundle ID:** `trade.socratic.app`
**Project:** `ios/Socratic Trade.xcodeproj` (space in the basename)
**Scheme / module:** `SocraticTrade`
**Team:** `CC8UTF7ATG`
**XcodeGen:** `ios/project.yml` — edit this, then `xcodegen generate`. After generate, restore `objectVersion = 100` / `preferredProjectObjectVersion = 100` if XcodeGen emitted 77. Do not hand-edit `project.pbxproj`.
**Ship:** `bash scripts/ios-ship-testflight.sh` — fleet: `/Users/jay/apps/ios-fleet/README.md`

Binding fleet rule: `/Users/jay/apps/AGENT-SYNC.md` § iOS agent build loop. `xcodebuild` / `xcrun simctl` via bash are pre-approved. Do not ask. Do not stand up or narrate Xcode MCP.

## Build & test

```bash
xcodebuild -project "ios/Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'generic/platform=iOS Simulator' build

xcodebuild -project "ios/Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' test
```

Discover simulators with `xcrun simctl list devices available`. Do not hardcode a name if that device is missing. After a user-visible change:

```bash
xcrun simctl io booted screenshot /tmp/st-ios-verify.png
```

`BUILD SUCCEEDED` is not visual QA.

## File structure

```
ios/
├── project.yml                         # XcodeGen source of truth
├── Socratic Trade.xcodeproj/           # generated — do not hand-edit
└── SocraticTrade/
    ├── SocraticTradeApp.swift          # App entry, deep links, launch
    ├── MobileStore.swift               # @Observable client store (auth, snapshot, commands)
    ├── MobileAPIClient.swift           # HTTP to /api/mobile
    ├── MobileModels.swift              # Decodable snapshot / command types
    ├── MobileControlView.swift         # Root tabs + more-stack
    ├── HomeView.swift                  # Home tab
    ├── MarketsView.swift               # Markets / watchlist
    ├── ActivityView.swift              # Activity tab
    ├── ProposalsView.swift             # Approvals / proposals
    ├── InsightsView.swift              # Insights
    ├── AdminPortalView.swift           # Admin fence
    ├── LoginView.swift                 # Sign-in
    ├── DeepLink.swift                  # Universal-link + push tap routing
    ├── PushNotifications.swift         # APNs register / tap
    ├── OrderCancel.swift               # Working-order cancel helpers
    ├── PolicyTightening.swift          # Ask-First ↔ Autopilot + raise/lower caps
    ├── AppComponents.swift             # Shared rows / chrome
    ├── AppTypography.swift             # Type ramp
    ├── CandleWordmarkView.swift        # Brand wordmark
    ├── SymbolInfoSheet.swift           # Ticker sheet
    └── PreviewSupport.swift            # SwiftUI previews
└── SocraticTradeTests/                 # XCTest
```

New views go next to the sibling they belong with. New files created outside XcodeGen `sources:` will not compile until `project.yml` lists them (this target includes the whole `SocraticTrade/` folder).

## Rules

- `@Observable` + `@MainActor` on stores. Never `ObservableObject`.
- `NavigationStack` + value-based `NavigationLink`. Never `NavigationView`.
- Light is the product default. Do not ship dark-first chrome.
- Two spaces between sentences in user-visible copy.
- Never hand-edit `.pbxproj`, `.entitlements`, `.xib`, `.storyboard`.
- Secrets stay in `~/.secrets/` / Infisical. Never print them.
