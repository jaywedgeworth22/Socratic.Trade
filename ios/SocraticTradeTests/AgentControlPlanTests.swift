import XCTest
@testable import SocraticTrade

final class AgentControlPlanTests: XCTestCase {
    func testActivePausedDoesNotShowStart() {
        let plan = AgentControlPlan.from(
            systemState: "active",
            runState: .pausedMarketClosed,
            authority: "decide",
            snapshotStale: false,
            ready: true
        )
        XCTAssertEqual(plan.primary, .stop)
        XCTAssertFalse(plan.showStart)
        XCTAssertTrue(plan.showStop)
        XCTAssertTrue(plan.statusTitle.contains("Waiting for Open"))
        XCTAssertTrue(plan.statusDetail.contains("not the same as the agent being stopped"))
    }

    func testHaltedShowsStartNotStop() {
        let plan = AgentControlPlan.from(
            systemState: "halted",
            runState: .stopped,
            authority: "propose",
            snapshotStale: false,
            ready: true
        )
        XCTAssertEqual(plan.primary, .start)
        XCTAssertTrue(plan.showStart)
        XCTAssertFalse(plan.showStop)
        XCTAssertEqual(plan.startLabel, "Start Agent")
        XCTAssertTrue(plan.startEnabled)
    }

    func testStaleSnapshotDisablesStartOnly() {
        let plan = AgentControlPlan.from(
            systemState: "halted",
            runState: .stopped,
            authority: "decide",
            snapshotStale: true,
            ready: true
        )
        XCTAssertFalse(plan.startEnabled)
        XCTAssertTrue(plan.startDisabledReason?.contains("Refresh") == true)
    }
}
