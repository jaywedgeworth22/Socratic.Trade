# iOS Logo Fixes

1. **Context & Objective**: Fixed the upside-down and backwards candlestick logo rendering on Mac Catalyst ("ios app on mac") and replaced the standard launch icon with a stacked candlestick wordmark on the launch screen as requested.
2. **Changes Made**: 
   - Replaced manually constructed, flipped `CGContext` logic with `UIGraphicsImageRenderer` in `CandleWordmarkView.swift` to properly generate text pixel data consistently on both iOS and Mac hardware.
   - Converted `CandleWordmarkModel` to a class to cache generated `Wordmark` structs keyed by `String` rather than hardcoding "SOCRATIC TRADE".
   - Modified `LaunchStateView` in `SocraticTradeApp.swift` to use stacked `CandleWordmarkView` blocks instead of the `RoundedRectangle` chart icon.
   - *Touched files*:
     - `ios/SocraticTrade/CandleWordmarkView.swift`
     - `ios/SocraticTrade/SocraticTradeApp.swift`
3. **Decisions & Trade-offs**: Moved to `UIGraphicsImageRenderer` because `NSString.draw(at:)` behavior internally varies within manually constructed CoreGraphics contexts across Apple Silicon Catalyst vs native iOS devices, whereas `UIGraphicsImageRenderer` abstracts context orientation differences away.
4. **Verification State**:
   - `swift` code syntactically validated.
   - `bash scripts/land.sh` run initiated in `ag/ios-logo-fixes` branch to build and test before PR.
5. **Next Steps & Blockers**: Wait for the PR to pass CI and merge. No blockers.
6. **Zero-Code Findings**: N/A
