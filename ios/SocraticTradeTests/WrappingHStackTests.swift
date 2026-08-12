import XCTest
@testable import SocraticTrade

final class WrappingHStackTests: XCTestCase {
    func testKeepsItemsOnOneLineWhenTheyFit() {
        let result = WrappingHStackLayout.place(
            widths: [100, 100],
            heights: [44, 44],
            containerWidth: 250,
            spacing: 8,
            lineSpacing: 8
        )

        XCTAssertEqual(result.origins, [CGPoint(x: 0, y: 0), CGPoint(x: 108, y: 0)])
        XCTAssertEqual(result.size, CGSize(width: 208, height: 44))
    }

    func testWrapsWhenARowWouldOverflow() {
        let result = WrappingHStackLayout.place(
            widths: [120, 120],
            heights: [44, 44],
            containerWidth: 200,
            spacing: 8,
            lineSpacing: 8
        )

        XCTAssertEqual(result.origins, [CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 52)])
        XCTAssertEqual(result.size, CGSize(width: 120, height: 96))
    }

    func testUnlimitedWidthNeverWraps() {
        let result = WrappingHStackLayout.place(
            widths: [180, 180, 180],
            heights: [40, 40, 40],
            containerWidth: .infinity,
            spacing: 8,
            lineSpacing: 8
        )

        XCTAssertEqual(result.origins.map(\.y), [0, 0, 0])
        XCTAssertEqual(result.size, CGSize(width: 556, height: 40))
    }

    func testWatchlistChipBudgetDoesNotFitTheOldAdaptiveMinimum() {
        // logo 18 + gaps 12 + 4-letter ticker ~40 + 44pt remove + leading 10 + trailing 2
        let fourLetterChip: CGFloat = 18 + 6 + 40 + 6 + 44 + 10 + 2
        XCTAssertGreaterThan(
            fourLetterChip,
            92,
            "The retired GridItem(.adaptive(minimum: 92)) was narrower than a logo+SPCX+remove chip, which is why tickers wrapped mid-symbol."
        )
        XCTAssertLessThan(
            fourLetterChip,
            180,
            "Two typical chips plus the 8pt gutter still fit a phone-width watchlist card."
        )
    }

    func testEmptySubviewsHaveZeroSize() {
        let result = WrappingHStackLayout.place(
            widths: [],
            heights: [],
            containerWidth: 320,
            spacing: 8,
            lineSpacing: 8
        )
        XCTAssertEqual(result.size, .zero)
        XCTAssertTrue(result.origins.isEmpty)
    }
}
