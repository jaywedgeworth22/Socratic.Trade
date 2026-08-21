import SwiftUI
import XCTest
@testable import SocraticTrade

/// Contract for the customizable tab bar.  Extends the web-parity rules
/// (app/console/lib/mobile-tabs.ts: membership set, canonical render order, silent
/// recovery from stale storage) with the three owner rules added 2026-08-21:
/// Home is required, the slot before More swaps, and the bar grows with the window.
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

    /// Every test that is not itself about window width runs at a width that comfortably
    /// holds the tabs it pins, so a capacity fallback never masks the behaviour under test.
    private func makePrefs(capacityForWidth width: CGFloat = 1180) -> TabPreferences {
        let prefs = TabPreferences(userDefaults: defaults)
        prefs.updateCapacity(width: width, horizontalSizeClass: .regular)
        return prefs
    }

    // MARK: - Defaults and ordering

    func testDefaultBarMatchesTheShippedFourTabs() {
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.barTabs, TabPreferences.defaultTabs)
        XCTAssertEqual(prefs.barTabs, [.home, .proposals, .markets, .activity])
        // Activity is the flex occupant, not a pin — that is what lets it be swapped out.
        XCTAssertEqual(prefs.flex, .activity)
        XCTAssertFalse(prefs.isPinned(.activity))
    }

    func testPinnedTabsRenderInCanonicalOrderAndTheFlexSlotIsAlwaysLast() {
        let prefs = makePrefs()
        prefs.toggle(.results)   // pin a screen that declares LAST of all customizable tabs
        prefs.setFlex(.coach)    // and put an EARLIER-declaring one in the flex slot
        // Pins in declaration order, then the flex slot, regardless of either one's
        // declaration index — the slot has to stay adjacent to More.
        XCTAssertEqual(prefs.barTabs, [.home, .proposals, .markets, .results, .coach])
        XCTAssertEqual(prefs.barLeadingTabs, [.home, .proposals, .markets, .results])
        XCTAssertEqual(prefs.barTrailingTab, .coach)
    }

    func testBarNeverContainsMoreOrADuplicate() {
        let prefs = makePrefs()
        prefs.setFlex(.more)
        prefs.toggle(.more)
        XCTAssertFalse(prefs.barTabs.contains(.more))
        XCTAssertEqual(Set(prefs.barTabs).count, prefs.barTabs.count)
    }

    // MARK: - Home is required

    func testHomeCanNeverLeaveTheBar() {
        let prefs = makePrefs()
        XCTAssertTrue(prefs.isRequired(.home))
        XCTAssertFalse(prefs.canToggle(.home))
        prefs.toggle(.home)
        XCTAssertTrue(prefs.isPinned(.home))
        XCTAssertTrue(prefs.barTabs.contains(.home))
        // Even a stored set that omits Home is repaired on load.
        defaults.set(["proposals", "markets"], forKey: "mobileTabs.stable.v2")
        defaults.set("activity", forKey: "mobileTabs.flex.v2")
        XCTAssertTrue(TabPreferences(userDefaults: defaults).barTabs.contains(.home))
    }

    func testHomeIsNeverAlsoTheFlexOccupant() {
        let prefs = makePrefs()
        prefs.setFlex(.home)
        XCTAssertNotEqual(prefs.flex, .home)
        XCTAssertEqual(Set(prefs.barTabs).count, prefs.barTabs.count)
    }

    // MARK: - The swappable slot

    func testOpeningAnUnpinnedScreenReplacesTheSlotBeforeMore() {
        let prefs = makePrefs()
        XCTAssertEqual(prefs.barTrailingTab, .activity)
        prefs.setFlex(.guardrails)
        XCTAssertEqual(prefs.barTrailingTab, .guardrails)
        XCTAssertFalse(prefs.barTabs.contains(.activity), "Activity should have stepped out")
        XCTAssertEqual(prefs.barTabs, [.home, .proposals, .markets, .guardrails])
    }

    func testOpeningAPinnedScreenLeavesTheSlotAlone() {
        let prefs = makePrefs()
        prefs.setFlex(.proposals) // already has a tab of its own
        XCTAssertEqual(prefs.barTrailingTab, .activity)
        XCTAssertEqual(prefs.barTabs, TabPreferences.defaultTabs)
    }

    func testTheSwappedSlotSurvivesRelaunch() {
        let prefs = makePrefs()
        prefs.setFlex(.scan)
        let reloaded = makePrefs()
        XCTAssertEqual(reloaded.flex, .scan)
        XCTAssertEqual(reloaded.barTrailingTab, .scan)
    }

    func testPinningTheFlexOccupantPromotesItAndRefillsTheSlot() {
        let prefs = makePrefs()
        prefs.setFlex(.coach)
        prefs.toggle(.coach) // pin the screen currently sitting in the slot
        XCTAssertTrue(prefs.isPinned(.coach))
        XCTAssertNotEqual(prefs.flex, .coach, "the slot must not duplicate a pin")
        XCTAssertEqual(Set(prefs.barTabs).count, prefs.barTabs.count)
        XCTAssertTrue(prefs.barTabs.contains(.coach))
    }

    // MARK: - Capacity follows the window

    func testCompactWidthAlwaysGetsThePhoneBar() {
        XCTAssertEqual(
            TabPreferences.capacity(forWidth: 393, horizontalSizeClass: .compact),
            TabPreferences.compactMaxTabs
        )
        // A wide window still reports the phone bar while the size class is compact.
        XCTAssertEqual(
            TabPreferences.capacity(forWidth: 1180, horizontalSizeClass: .compact),
            TabPreferences.compactMaxTabs
        )
    }

    func testRegularWidthEarnsMoreSlotsAsTheWindowGrows() {
        let portrait = TabPreferences.capacity(forWidth: 820, horizontalSizeClass: .regular)
        let landscape = TabPreferences.capacity(forWidth: 1180, horizontalSizeClass: .regular)
        XCTAssertGreaterThan(portrait, TabPreferences.compactMaxTabs, "iPad Air portrait should beat the phone bar")
        XCTAssertGreaterThan(landscape, portrait, "landscape should beat portrait")
        XCTAssertLessThanOrEqual(landscape, TabPreferences.regularMaxTabs)
        // A narrow Catalyst window is never worse than a phone.
        XCTAssertEqual(
            TabPreferences.capacity(forWidth: 640, horizontalSizeClass: .regular),
            TabPreferences.compactMaxTabs
        )
    }

    func testMoreTabsCanBePinnedOnAWideWindowThanOnAPhone() {
        let wide = makePrefs(capacityForWidth: 1180)
        XCTAssertTrue(wide.canToggle(.insights))
        wide.toggle(.insights)
        wide.toggle(.scan)
        XCTAssertGreaterThan(wide.barTabs.count, TabPreferences.compactMaxTabs)
        XCTAssertEqual(wide.barTabs, [.home, .proposals, .markets, .insights, .scan, .activity])
    }

    func testNarrowingFallsBackToTheDefaultsWithoutForgettingThePins() {
        let prefs = makePrefs(capacityForWidth: 1180)
        prefs.toggle(.insights)
        prefs.toggle(.scan)
        let wideBar = prefs.barTabs
        XCTAssertTrue(wideBar.contains(.insights) && wideBar.contains(.scan))

        // Drag the window down to phone width.
        prefs.updateCapacity(width: 390, horizontalSizeClass: .compact)
        XCTAssertEqual(prefs.barTabs, TabPreferences.defaultTabs)
        XCTAssertTrue(prefs.isPinned(.insights), "the pin itself must survive the narrowing")

        // …and back out again.
        prefs.updateCapacity(width: 1180, horizontalSizeClass: .regular)
        XCTAssertEqual(prefs.barTabs, wideBar)
    }

    func testTheOpenScreenKeepsItsTabEvenInTheNarrowFallback() {
        // Regression guard: falling back to a literal default set would drop the screen the
        // owner is looking at, leaving `selectedTab` pointing at a Tab that no longer exists.
        let prefs = makePrefs(capacityForWidth: 1180)
        prefs.toggle(.insights)
        prefs.toggle(.scan)
        prefs.setFlex(.guardrails)
        prefs.updateCapacity(width: 390, horizontalSizeClass: .compact)
        XCTAssertEqual(prefs.barTabs.count, TabPreferences.compactMaxTabs)
        XCTAssertTrue(prefs.barTabs.contains(.guardrails), "the open screen must keep its tab")
        XCTAssertEqual(prefs.barTrailingTab, .guardrails)
    }

    func testPinCeilingTracksTheWindow() {
        let phone = makePrefs(capacityForWidth: 390)
        phone.updateCapacity(width: 390, horizontalSizeClass: .compact)
        // Home + 2 pins + the flex slot already fills a phone bar.
        XCTAssertFalse(phone.canToggle(.insights))
        phone.toggle(.insights)
        XCTAssertFalse(phone.isPinned(.insights))
    }

    // MARK: - Persistence and recovery

    func testUnpinPersistsAndSurvivesReload() {
        let prefs = makePrefs()
        prefs.toggle(.markets)
        XCTAssertFalse(prefs.isPinned(.markets))
        XCTAssertEqual(makePrefs().barTabs, [.home, .proposals, .activity])
    }

    func testMinimumBoundKeepsOnePinBesidesHome() {
        let prefs = makePrefs()
        prefs.toggle(.markets)
        prefs.toggle(.proposals)
        XCTAssertEqual(prefs.stable, [.home])
        XCTAssertEqual(prefs.barTabs.count, TabPreferences.minTabs)
        // Nothing left to give up.
        XCTAssertFalse(prefs.canToggle(.home))
    }

    func testStaleAndInvalidStoredValuesRecoverSafely() {
        defaults.set(["home", "renamed_screen_that_no_longer_exists", "more"], forKey: "mobileTabs.stable.v2")
        defaults.set("also_not_a_screen", forKey: "mobileTabs.flex.v2")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.stable, [.home])
        XCTAssertEqual(prefs.flex, TabPreferences.defaultFlex)
        XCTAssertFalse(prefs.barTabs.contains(.more))
    }

    func testLegacyV1StorageMigratesItsLastTabIntoTheFlexSlot() {
        // v1 stored one flat pinned list rendered in canonical order, so its last canonical
        // entry is the one that sat where the flex slot now sits.
        defaults.set(["home", "proposals", "markets", "activity"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.stable, [.home, .proposals, .markets])
        XCTAssertEqual(prefs.flex, .activity)
        XCTAssertEqual(prefs.barTabs, TabPreferences.defaultTabs, "the bar must look identical after upgrade")
    }

    func testLegacyV1StorageThatWasCustomisedMigratesToo() {
        defaults.set(["home", "coach"], forKey: "mobileTabs.v1")
        let prefs = TabPreferences(userDefaults: defaults)
        XCTAssertEqual(prefs.barTabs, [.home, .coach])
    }

    func testEnsureVisibleKeepsTheOpenScreenWhenNarrowingDropsItsPin() {
        let prefs = makePrefs(capacityForWidth: 1180)
        prefs.toggle(.insights)
        prefs.toggle(.scan)
        // Owner is looking at Insights, a pin that a phone-width bar has no room for.
        prefs.updateCapacity(width: 390, horizontalSizeClass: .compact)
        XCTAssertFalse(prefs.barTabs.contains(.insights))
        prefs.ensureVisible(.insights)
        XCTAssertTrue(prefs.barTabs.contains(.insights))
        XCTAssertEqual(prefs.barTrailingTab, .insights)
        XCTAssertTrue(prefs.isPinned(.insights), "parking it must not unpin it")
        // Widening restores the full set — and Insights appears exactly once.
        prefs.updateCapacity(width: 1180, horizontalSizeClass: .regular)
        XCTAssertEqual(prefs.barTabs.filter { $0 == .insights }.count, 1)
        XCTAssertEqual(Set(prefs.barTabs).count, prefs.barTabs.count)
    }

    func testEnsureVisibleIsANoOpForAScreenAlreadyOnTheBar() {
        let prefs = makePrefs()
        let before = prefs.barTabs
        prefs.ensureVisible(.proposals)
        prefs.ensureVisible(.more)
        XCTAssertEqual(prefs.barTabs, before)
    }

    func testMoreIsNeverCustomizable() {
        XCTAssertFalse(AppTab.customizable.contains(.more))
        let prefs = makePrefs()
        prefs.toggle(.more)
        XCTAssertFalse(prefs.isPinned(.more))
    }
}
