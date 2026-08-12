import XCTest
@testable import SocraticTrade

/// Web-parity contract for the customizable tab bar (app/console/lib/mobile-tabs.ts):
/// same min/max bounds, membership-set ordering, silent recovery from stale storage.
@MainActor
final class TabPreferencesTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suiteName = "TabPreferencesTests"

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testDefaultsWhenNothingStored() {
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned, TabPreferences.defaultTabs)
        XCTAssertEqual(prefs.barTabs, [.home, .proposals, .markets, .activity])
    }

    func testUnpinPersistsAndSurvivesReload() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.toggle(.activity)
        XCTAssertFalse(prefs.isPinned(.activity))

        let reloaded = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(reloaded.barTabs, [.home, .proposals, .markets])
    }

    func testBarRendersCanonicalOrderNotPinOrder() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.toggle(.home)      // unpin home      (4 -> 3)
        prefs.toggle(.proposals) // unpin proposals (3 -> 2)
        prefs.toggle(.insights)  // pin insights    (2 -> 3)
        prefs.toggle(.home)      // re-pin home     (3 -> 4) — appends LAST in `pinned`
        XCTAssertEqual(prefs.pinned.last, .home)
        // …but the bar must render declaration order, regardless of pin sequence.
        XCTAssertEqual(prefs.barTabs, [.home, .markets, .activity, .insights])
    }

    func testMinimumBoundBlocksUnpin() {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.toggle(.activity)
        prefs.toggle(.markets)
        XCTAssertEqual(prefs.pinned.count, TabPreferences.minTabs)
        XCTAssertFalse(prefs.canToggle(.home))
        prefs.toggle(.home) // must be a no-op at the floor
        XCTAssertTrue(prefs.isPinned(.home))
        XCTAssertEqual(prefs.pinned.count, TabPreferences.minTabs)
    }

    func testMaximumBoundBlocksPin() {
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned.count, TabPreferences.maxTabs)
        XCTAssertFalse(prefs.canToggle(.insights))
        prefs.toggle(.insights) // must be a no-op at the ceiling
        XCTAssertFalse(prefs.isPinned(.insights))
    }

    func testStaleAndInvalidStoredValuesRecoverSafely() {
        // A removed screen name and `more` (never pinnable) must both be dropped;
        // dropping below the minimum resets to defaults rather than a broken bar.
        defaults.set(["home", "renamed_screen_that_no_longer_exists", "more"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned, TabPreferences.defaultTabs)
    }

    func testStoredSelectionAboveMaxIsClamped() {
        defaults.set(["home", "proposals", "markets", "activity", "insights"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.pinned.count, TabPreferences.maxTabs)
    }

    func testMoreIsNeverCustomizable() {
        XCTAssertFalse(AppTab.customizable.contains(.more))
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.toggle(.activity) // free a slot so a pin would otherwise succeed
        prefs.toggle(.more)
        XCTAssertFalse(prefs.isPinned(.more))
    }
}
