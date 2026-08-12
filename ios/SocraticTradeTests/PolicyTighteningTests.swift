import XCTest
@testable import SocraticTrade

/// Tighten-only is the whole safety property of the phone's guardrail controls, so it is a pure
/// function tested directly: no proposed value may ever be looser than what the snapshot says
/// the policy is today.
final class PolicyTighteningTests: XCTestCase {
    func testOnlyAutopilotHasSomewhereTighterToGo() {
        XCTAssertEqual(PolicyTightening.tightenedAuthority(current: "decide"), "propose")
        XCTAssertEqual(PolicyTightening.tightenedAuthority(current: " DECIDE "), "propose")
        // Already Ask-First: nothing to offer.  Loosening back to Autopilot is console-only.
        XCTAssertNil(PolicyTightening.tightenedAuthority(current: "propose"))
        XCTAssertNil(PolicyTightening.tightenedAuthority(current: nil))
        XCTAssertNil(PolicyTightening.tightenedAuthority(current: ""))
        XCTAssertNil(PolicyTightening.tightenedAuthority(current: "something-new"))
    }

    func testCapReductionsAreStrictlyLowerAndRespectTheServerFloor() {
        XCTAssertEqual(
            PolicyTightening.tightenedCap(current: 2500, competingPercentCap: nil, fraction: 0.5),
            1250
        )
        // Rounds DOWN, so rounding can never produce a value above the request.
        XCTAssertEqual(
            PolicyTightening.tightenedCap(current: 999, competingPercentCap: nil, fraction: 0.75),
            749
        )
        // Server floor is 1 (numericFields: ["maxOrderNotional", 1, 100_000]).
        XCTAssertNil(PolicyTightening.tightenedCap(current: 1.2, competingPercentCap: nil, fraction: 0.25))
        XCTAssertNil(PolicyTightening.tightenedCap(current: 1, competingPercentCap: nil, fraction: 0.5))
    }

    func testNeverProposesAValueThatWouldRaiseOrHoldTheCap() {
        for fraction in [1.0, 1.25, 2.0, 0.0, -0.5] {
            XCTAssertNil(
                PolicyTightening.tightenedCap(current: 2500, competingPercentCap: nil, fraction: fraction),
                "fraction \(fraction) is not a reduction"
            )
        }
        for value in PolicyTightening.tightenedCapOptions(current: 2500, competingPercentCap: nil) {
            XCTAssertLessThan(value, 2500)
            XCTAssertGreaterThanOrEqual(value, PolicyTightening.minimumNotional)
        }
    }

    func testUnknownOrPercentBasedCapsOfferNothing() {
        // No value in the snapshot: "lower than unknown" is not a claim this app can make.
        XCTAssertNil(PolicyTightening.tightenedCap(current: nil, competingPercentCap: nil, fraction: 0.5))
        XCTAssertTrue(PolicyTightening.tightenedCapOptions(current: nil, competingPercentCap: nil).isEmpty)
        // A stored percent-of-NAV cap makes the notional/percent pair exclusive server-side
        // (normalizeExclusivePolicyCaps): sending a notional would DELETE the percent cap and
        // change which rule binds — possibly a loosening.  Console owns that switch.
        XCTAssertNil(PolicyTightening.tightenedCap(current: 2500, competingPercentCap: 5, fraction: 0.5))
        XCTAssertTrue(PolicyTightening.tightenedCapOptions(current: 2500, competingPercentCap: 5).isEmpty)
        XCTAssertNil(PolicyTightening.tightenedCap(current: .nan, competingPercentCap: nil, fraction: 0.5))
        XCTAssertNil(PolicyTightening.tightenedCap(current: .infinity, competingPercentCap: nil, fraction: 0.5))
    }

    func testOptionsAreOrderedMildestFirstAndDeduplicated() {
        XCTAssertEqual(PolicyTightening.tightenedCapOptions(current: 2000, competingPercentCap: nil), [1500, 1000, 500])
        // Small caps collapse to fewer distinct whole-dollar values; no duplicates survive
        // (a $2 cap rounds 75% and 50% to the same $1, and 25% falls under the floor).
        XCTAssertEqual(PolicyTightening.tightenedCapOptions(current: 2, competingPercentCap: nil), [1])
    }

    /// The offered value is absolute and `policy.patch` is queued, so the tap-time re-check is
    /// what stops a menu built against an older, larger cap from RAISING a cap that dropped in
    /// the meantime.  The server enforces no direction.
    func testAStaleOptionIsRefusedOnceTheCapHasMovedUnderIt() throws {
        let policy = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":10000}"#)

        // Built when the cap was $10,000 and still a tightening.
        XCTAssertTrue(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: policy))

        // The console (or an earlier queued tighten) has since dropped it to $1,000: re-sending
        // the $7,500 option would raise it.
        let lowered = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":1000}"#)
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: lowered))
        // Equal value is not a tightening either — it would spend a command to change nothing.
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 1000, in: lowered))
        XCTAssertTrue(PolicyTightening.isStillATightening(.maxOrderNotional, value: 750, in: lowered))

        // The cap became percent-of-NAV based, or vanished, while the menu was open.
        let percentBased = try snapshotPolicy(
            #"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":10000,"maxOrderPctOfNav":5}"#
        )
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: percentBased))
        let unset = try snapshotPolicy(#"{"systemState":"active","strategyAuthority":"decide"}"#)
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: unset))
        // No snapshot at all cannot answer "lower than what?".
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: nil))

        // Caps are checked independently — a daily-cap option is judged against the daily cap.
        let both = try snapshotPolicy(
            #"{"systemState":"active","strategyAuthority":"decide","maxOrderNotional":1000,"maxDailyNotional":10000}"#
        )
        XCTAssertFalse(PolicyTightening.isStillATightening(.maxOrderNotional, value: 7500, in: both))
        XCTAssertTrue(PolicyTightening.isStillATightening(.maxDailyNotional, value: 7500, in: both))

        // Every value the menu builder offers passes its own re-check against the same policy.
        for value in PolicyTightening.tightenedCapOptions(current: 10000, competingPercentCap: nil) {
            XCTAssertTrue(PolicyTightening.isStillATightening(.maxOrderNotional, value: value, in: policy))
        }
    }

    private func snapshotPolicy(_ policyJSON: String) throws -> PolicySummary {
        let json = """
        {
          "readiness": {
            "hasAccount": true,
            "hasUniverse": true,
            "systemState": "active",
            "strategyAuthority": "decide",
            "selectedAccountNumber": "account-number",
            "activeConnectedAccount": null,
            "commandBacklog": {"queued": 0, "running": 0}
          },
          "policy": \(policyJSON)
        }
        """
        return try JSONDecoder().decode(MobileSnapshot.self, from: Data(json.utf8)).policy
    }

    func testPayloadsMatchTheServerPolicyPatchContract() {
        let authority = PolicyTightening.authorityPayload()
        let patch = try? XCTUnwrap(authority["patch"] as? [String: Any])
        XCTAssertEqual(patch?["strategyAuthority"] as? String, "propose")

        let capPayload = PolicyTightening.capPayload(.maxDailyNotional, value: 1250)
        let capPatch = try? XCTUnwrap(capPayload["patch"] as? [String: Any])
        XCTAssertEqual(capPatch?["maxDailyNotional"] as? Double, 1250)
        // Field names are the server's own TradingPolicy keys, not app-invented aliases.
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.rawValue, "maxOrderNotional")
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.rawValue, "maxDailyNotional")
    }

    func testCapsReadTheirOwnFieldsFromTheSnapshotPolicy() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(policySnapshotJSON.utf8))

        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.currentValue(in: snapshot.policy), 2500)
        XCTAssertEqual(PolicyTightening.Cap.maxDailyNotional.currentValue(in: snapshot.policy), 10000)
        XCTAssertEqual(PolicyTightening.Cap.maxOrderNotional.competingPercentCap(in: snapshot.policy), 5)
        XCTAssertNil(PolicyTightening.Cap.maxDailyNotional.competingPercentCap(in: snapshot.policy))
        // maxOrderNotional carries a competing percent cap here, so only the daily cap is offerable.
        XCTAssertTrue(
            PolicyTightening.tightenedCapOptions(
                current: PolicyTightening.Cap.maxOrderNotional.currentValue(in: snapshot.policy),
                competingPercentCap: PolicyTightening.Cap.maxOrderNotional.competingPercentCap(in: snapshot.policy)
            ).isEmpty
        )
        XCTAssertFalse(
            PolicyTightening.tightenedCapOptions(
                current: PolicyTightening.Cap.maxDailyNotional.currentValue(in: snapshot.policy),
                competingPercentCap: PolicyTightening.Cap.maxDailyNotional.competingPercentCap(in: snapshot.policy)
            ).isEmpty
        )
    }

    private let policySnapshotJSON = #"""
    {
      "readiness": {
        "hasAccount": true,
        "hasUniverse": true,
        "systemState": "active",
        "strategyAuthority": "decide",
        "selectedAccountNumber": "account-number",
        "activeConnectedAccount": null,
        "commandBacklog": {"queued": 0, "running": 0}
      },
      "policy": {
        "systemState": "active",
        "strategyAuthority": "decide",
        "maxOrderNotional": 2500,
        "maxOrderPctOfNav": 5,
        "maxDailyNotional": 10000
      }
    }
    """#
}
