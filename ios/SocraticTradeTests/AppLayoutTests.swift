import SwiftUI
import XCTest
@testable import SocraticTrade

/// Breakpoint arithmetic for the adaptive layout added 2026-08-21.  Pure functions only,
/// so these run without hosting SwiftUI — same split `WrappingHStackTests` uses.
///
/// The claim these exist to defend is "iPhone is byte-identical".  For the ceilings that
/// is arithmetic (`min(ceiling, ≤408pt)` is always the proposal); for the grid it is the
/// compact early return, which is what `testCompactAlwaysTwoColumns` pins.
final class AppLayoutTests: XCTestCase {
    /// Widest content an iPhone in this app ever proposes: 440pt (Pro Max) less 32pt of
    /// gutters.  The app is portrait-locked on iPhone, so landscape cannot widen this.
    private let widestPhoneContent: CGFloat = 408

    // MARK: - Ceilings are inert on iPhone

    func testEveryCeilingIsAboveTheWidestPhoneContent() {
        for column in [AppLayout.Column.reading, .standard, .wide] {
            XCTAssertGreaterThan(column.maxWidth, widestPhoneContent, "\(column) would bind on iPhone")
        }
        // Card-interior ceilings are compared against the interior, not the screen:
        // an AppCard's 16pt padding leaves ~376pt inside on the widest phone.
        let widestPhoneCardInterior = widestPhoneContent - 32
        for ceiling in [AppLayout.prose, AppLayout.message, AppLayout.action, AppLayout.entryRow] {
            XCTAssertGreaterThan(ceiling, widestPhoneCardInterior, "\(ceiling) would bind inside an iPhone card")
        }
    }

    func testColumnsAreOrderedAndDistinct() {
        XCTAssertLessThan(AppLayout.Column.reading.maxWidth, AppLayout.Column.standard.maxWidth)
        XCTAssertLessThan(AppLayout.Column.standard.maxWidth, AppLayout.Column.wide.maxWidth)
    }

    func testGutterKeepsThePhoneConstant() {
        XCTAssertEqual(AppLayout.gutter(.compact), 16, "16 is the literal that ships today")
        XCTAssertEqual(AppLayout.gutter(nil), 16, "an unknown size class must not widen the phone")
        XCTAssertGreaterThan(AppLayout.gutter(.regular), AppLayout.gutter(.compact))
    }

    func testChatRowLeavesRoomForTheOppositeGutter() {
        XCTAssertGreaterThan(AppLayout.chatRow, AppLayout.chatBubble)
    }

    // MARK: - Metric grid

    func testCompactAlwaysTwoColumns() {
        // The early return that makes iPhone byte-identical: no width math runs at all.
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 4, availableWidth: 358, isRegularWidth: false), 2)
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 7, availableWidth: 358, isRegularWidth: false), 2)
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 4, availableWidth: 1148, isRegularWidth: false), 2)
    }

    func testSingleTileNeverSplits() {
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 1, availableWidth: 1148, isRegularWidth: true), 1)
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 1, availableWidth: 358, isRegularWidth: false), 1)
    }

    func testIPadLandscapeAndPortraitBothGiveOneRow() {
        // Home's four portfolio tiles: two half-empty rows become one.
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 4, availableWidth: 772, isRegularWidth: true), 4)
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 4, availableWidth: 1148, isRegularWidth: true), 4)
    }

    func testSheetWidthKeepsTilesAboveTheMinimum() {
        // SymbolInfoSheet's 7 key stats in a ~672pt page sheet.  This is the case a
        // size-class-only rule gets wrong: a sheet inherits the WINDOW's size class.
        let columns = AppMetricGridLayout.columnCount(itemCount: 7, availableWidth: 672, isRegularWidth: true)
        XCTAssertEqual(columns, 3)
        XCTAssertGreaterThanOrEqual(672 / CGFloat(columns), AppMetricGridLayout.minimumTileWidth)
    }

    func testUnmeasuredWidthAssumesRoomyToAvoidReflowOnAppear() {
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 4, availableWidth: 0, isRegularWidth: true), 4)
    }

    func testNarrowCatalystWindowDegrades() {
        // Catalyst reports .regular at EVERY window width, so the width has to carry this.
        XCTAssertEqual(AppMetricGridLayout.columnCount(itemCount: 4, availableWidth: 568, isRegularWidth: true), 3)
        XCTAssertGreaterThanOrEqual(
            AppMetricGridLayout.columnCount(itemCount: 4, availableWidth: 300, isRegularWidth: true), 2
        )
    }

    func testNoTileIsEverNarrowerThanTheMinimumOnceMeasured() {
        for width in stride(from: CGFloat(360), through: 1200, by: 40) {
            for count in 2...8 {
                let columns = AppMetricGridLayout.columnCount(
                    itemCount: count, availableWidth: width, isRegularWidth: true
                )
                XCTAssertGreaterThanOrEqual(columns, 2)
                XCTAssertLessThanOrEqual(columns, count)
                if columns > 2 {
                    XCTAssertGreaterThanOrEqual(
                        width / CGFloat(columns), AppMetricGridLayout.minimumTileWidth,
                        "\(count) tiles at \(width)pt packed \(columns)-up below the minimum"
                    )
                }
            }
        }
    }
}
