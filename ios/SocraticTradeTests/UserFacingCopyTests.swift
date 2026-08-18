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
            "The scan could not price any names.  Refresh after quotes recover, or confirm the universe on Guardrails."
        )
        assertOrdinary(DeskCopy.scanUniverseNote)
        assertOrdinary(DeskCopy.scanCountLine(names: 0, scanned: 503, quotes: 0, watched: 2))
        assertOrdinary(DeskCopy.scanEmptyMessage(scanned: 503, quotes: 0, hasFilter: false))
    }

    func testWorkspaceErrorsStayOrdinary() {
        assertOrdinary(MobileAPIError.serverError(statusCode: 522, message: nil).errorDescription ?? "")
        assertOrdinary(MobileAPIError.serverError(statusCode: 500, message: nil).errorDescription ?? "")
        assertOrdinary(MobileAPIError.decoding(NSError(domain: "test", code: 1)).errorDescription ?? "")
        assertOrdinary(MobileAPIError.network(NSError(domain: "test", code: 1)).errorDescription ?? "")
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
