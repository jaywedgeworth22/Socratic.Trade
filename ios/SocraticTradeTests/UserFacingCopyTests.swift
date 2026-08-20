import XCTest
@testable import SocraticTrade

/// Owner 2026-08-18: user-visible iOS copy is ordinary app language.
/// Notes for Jay stay in the PR, not the UI.
final class UserFacingCopyTests: XCTestCase {
    private let forbidden = [
        "additional fields from /api/policy",
        "values from the latest snapshot",
        "phone-safe reductions only",
        "this deployment does not advertise policy.patch",
        "console only",
        "not set — console only",
        "set as % of NAV — console only",
        "returning to autopilot or raising a cap is done in the web console",
        "production push service",
        "registered with apple",
        "/api/policy",
        "policy.patch",
        "apns",
        "__rotate__"
    ]

    func testCommandLabelsNeverShowRouteOrCommandTypes() {
        let types = [
            "strategy.run_once",
            "strategy.start",
            "strategy.stop",
            "strategy.close_only",
            "strategy.liquidating",
            "proposal.approve",
            "proposal.reject",
            "proposal.retry_red_team",
            "account.activate",
            "order.cancel",
            "watchlist.add",
            "watchlist.remove",
            "alert.create",
            "alert.delete",
            "policy.patch",
            "unknown.command_type"
        ]
        for type in types {
            let label = AppFormat.commandLabel(type)
            XCTAssertFalse(label.contains("."), "\(type) → \(label)")
            XCTAssertFalse(label.contains("_"), "\(type) → \(label)")
            XCTAssertFalse(label.lowercased().contains("policy.patch"), label)
            assertOrdinary(label)
        }
        XCTAssertEqual(AppFormat.commandLabel("policy.patch"), "Policy Change")
    }

    func testRotationSeatIsLowercaseRotateModels() {
        XCTAssertEqual(DeskCopy.modelSeatValue("__rotate__"), "rotate models")
        XCTAssertEqual(DeskCopy.modelSeatValue("__rotate__", fallbacks: ["x"]), "rotate models")
        assertOrdinary(DeskCopy.modelSeatValue("__rotate__"))
    }

    func testCapDisplayNeverSendsTheUserToTheConsole() {
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.displayValue(in: nil), "not set")
        assertOrdinary(PolicyTightening.Cap.maxDailyNotional.displayValue(in: nil))
    }

    func testPushFooterNeverMentionsApplePlumbing() {
        assertOrdinary(PushAlertState.registered(environment: .production).summary)
        assertOrdinary(PushAlertState.registered(environment: .sandbox).summary)
        assertOrdinary(PushAlertState.failureSummary("APNs BadDeviceToken sandbox production"))
        XCTAssertEqual(PushAlertState.registered(environment: .production).summary, "Alerts on.")
    }

    func testIndexRowsNeverShowStorageSlugs() {
        let line = DeskCopy.joinedIndexList(["sp500", "nasdaq100", "ftWilshire5000"])
        XCTAssertEqual(line, "S&P 500, Nasdaq 100, FT Wilshire 5000")
        assertOrdinary(line)
        let liveLeak = DeskCopy.joinedIndexList(["sp500", "nasdaqComposite", "dow30", "nyseComposite"])
        XCTAssertEqual(liveLeak, "S&P 500, Nasdaq Composite, Dow 30, NYSE Composite")
        for slug in ["sp100", "sp500", "nasdaq100", "nasdaqComposite", "dow30", "russell2000", "nyseComposite", "ftWilshire5000"] {
            XCTAssertFalse(line.contains(slug), "\(line) still contains \(slug)")
            XCTAssertFalse(liveLeak.contains(slug), "\(liveLeak) still contains \(slug)")
        }
    }

    func testUniverseCopyMatchesWebGuardrailsNotAMissingStrategyPage() {
        XCTAssertEqual(
            DeskCopy.universeNeedsIndex,
            "Choose at least one base index (e.g. S&P 500) or add extra symbols so the strategy has names to scan."
        )
        XCTAssertEqual(
            DeskCopy.universeRefreshAfterGuardrails,
            "Add an index or extra symbols on Guardrails, then pull to refresh here."
        )
        XCTAssertEqual(
            DeskCopy.universeInsightDetail,
            "Choose at least one base index (e.g. S&P 500) or add extra symbols."
        )
        XCTAssertTrue(DeskCopy.universeNeedsIndex.contains("S&P 500"))
        XCTAssertTrue(DeskCopy.universeRefreshAfterGuardrails.contains("Guardrails"))
        for text in [
            DeskCopy.universeNeedsIndex,
            DeskCopy.universeRefreshAfterGuardrails,
            DeskCopy.universeInsightDetail
        ] {
            XCTAssertFalse(text.contains("Strategy page"), text)
            XCTAssertFalse(text.contains("sp500"), text)
            assertOrdinary(text)
        }
    }

    func testScanCopyDoesNotTreatWatchlistAsTheUniverse() {
        XCTAssertEqual(
            DeskCopy.scanCountLine(names: 0, scanned: 503, quotes: 0, watched: 2),
            "0 names · 503 scanned · 0 quotes · 2 watched"
        )
        XCTAssertTrue(DeskCopy.scanUniverseNote.contains("Watchlist names are not the scan universe"))
        XCTAssertEqual(
            DeskCopy.scanEmptyMessage(scanned: 0, quotes: 0, hasFilter: false),
            "This universe has no symbols.  Choose a base index or add symbols on Guardrails, then refresh."
        )
        XCTAssertEqual(
            DeskCopy.scanEmptyMessage(scanned: 503, quotes: 0, hasFilter: false),
            "The scan could not price any names.  Refresh after quotes recover."
        )
        XCTAssertFalse(
            DeskCopy.scanEmptyMessage(scanned: 505, quotes: 0, hasFilter: false)
                .localizedCaseInsensitiveContains("Guardrails")
        )
        assertOrdinary(DeskCopy.scanUniverseNote)
        assertOrdinary(DeskCopy.scanCountLine(names: 0, scanned: 503, quotes: 0, watched: 2))
        assertOrdinary(DeskCopy.scanEmptyMessage(scanned: 503, quotes: 0, hasFilter: false))
        assertOrdinary(DeskCopy.scanLoadingNote)
        XCTAssertFalse(DeskCopy.scanLoadingNote.contains("503"))
        let banner = DeskCopy.scanRefreshFailedBanner(
            reason: "The live refresh did not finish.",
            lastGoodAt: "2026-08-18T19:25:13.000Z"
        )
        assertOrdinary(banner)
        XCTAssertTrue(banner.contains("Showing the last good scan from"))
        XCTAssertFalse(banner.contains("503"))
    }

    func testScanRefreshCopyIsNotTheWorkspaceConnectionBanner() {
        XCTAssertNotEqual(
            DeskCopy.scanRefreshFailed(from: DeskCopy.genericConnectionMessage),
            DeskCopy.genericConnectionMessage
        )
        XCTAssertTrue(
            DeskCopy.scanRefreshFailed(from: DeskCopy.genericConnectionMessage)
                .localizedStandardContains("market scan")
        )
        XCTAssertEqual(
            DeskCopy.scanRefreshFailed(from: "Socratic Trade is unreachable right now.  Try again in a few minutes."),
            "Socratic Trade is unreachable right now.  Try again in a few minutes."
        )
        assertOrdinary(DeskCopy.scanRefreshFailed(from: DeskCopy.genericConnectionMessage))
        assertOrdinary(DeskCopy.scanEmptyUniverse)
        assertOrdinary(DeskCopy.scanRefreshing)
        XCTAssertTrue(DeskCopy.scanRefreshing.contains("45"))
        XCTAssertFalse(DeskCopy.shouldShowScanEmptyState(hasFilter: false, loadFailed: true))
        XCTAssertTrue(DeskCopy.shouldShowScanEmptyState(hasFilter: false, loadFailed: false))
        XCTAssertTrue(DeskCopy.shouldShowScanEmptyState(hasFilter: true, loadFailed: true))
    }

    func testPortfolioEmptyCopyNamesTheBrokerWhenAnAccountIsSelected() {
        XCTAssertEqual(
            DeskCopy.portfolioUnavailableMessage(hasConnectedAccount: true),
            DeskCopy.portfolioBrokerUnreachable
        )
        XCTAssertEqual(
            DeskCopy.portfolioUnavailableMessage(hasConnectedAccount: false),
            DeskCopy.portfolioSelectAccount
        )
        XCTAssertEqual(DeskCopy.equityWaitingOnBroker, "waiting on broker")
        assertOrdinary(DeskCopy.portfolioBrokerUnreachable)
        assertOrdinary(DeskCopy.portfolioSelectAccount)
        assertOrdinary(DeskCopy.equityWaitingOnBroker)
    }

    func testWorkspaceErrorsStayOrdinary() throws {
        assertOrdinary(MobileAPIError.serverError(statusCode: 522, message: nil).errorDescription ?? "")
        assertOrdinary(MobileAPIError.serverError(statusCode: 500, message: nil).errorDescription ?? "")
        assertOrdinary(MobileAPIError.decoding(NSError(domain: "test", code: 1)).errorDescription ?? "")
        assertOrdinary(MobileAPIError.network(NSError(domain: "test", code: 1)).errorDescription ?? "")
        let scanJSON = Data(#"""
        {"scannedSymbols":505,"returnedQuotes":0,"warnings":["This operation was aborted"],"topCandidates":[]}
        """#.utf8)
        let scan = try JSONDecoder().decode(MarketScanResponse.self, from: scanJSON)
        assertOrdinary(MobileAPIError.scanQuotesUnavailable(scan).errorDescription ?? "")
        XCTAssertEqual(
            MobileAPIError.serverError(statusCode: 500, message: nil).errorDescription,
            "Something went wrong.  Try again."
        )
    }

    private func assertOrdinary(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
        let lower = text.lowercased()
        for token in forbidden {
            XCTAssertFalse(lower.contains(token), "\(text) still contains \(token)", file: file, line: line)
        }
        XCTAssertFalse(text.contains("__"), "\(text) still contains a dunder token", file: file, line: line)
    }
}
