import XCTest
@testable import SocraticTrade

final class MobileModelsTests: XCTestCase {
    func testSnapshotDecodesEveryMobileDashboardSection() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(fullSnapshotJSON.utf8))

        XCTAssertEqual(snapshot.marketSession, "regular")
        XCTAssertEqual(snapshot.scheduler.nextRunAt, "2026-07-21T18:00:00.000Z")
        XCTAssertEqual(snapshot.positions.first?.symbol, "AAPL")
        XCTAssertEqual(snapshot.orders.first?.state, "filled")
        XCTAssertEqual(snapshot.dailyStats.openingOrderCount, 1)
        XCTAssertEqual(snapshot.performance?.liveRealizedPnl, 125.50)
        XCTAssertEqual(snapshot.performance?.benchmark?.excessReturnPct, 1.2)
        XCTAssertEqual(snapshot.connectedAccounts.first?.environment, "live")
        XCTAssertEqual(snapshot.alerts.first?.triggeredPrice, 205)
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.tradeThesisTag, "quality")
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.proposedByModel, "openrouter/openai/gpt-5-mini")
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.redTeamVerdict?.verdict, "approve-at-half")
        XCTAssertEqual(snapshot.pendingProposals.first?.proposal.redTeamVerdict?.available, true)
        XCTAssertEqual(snapshot.recentCommands.first?.status, "succeeded")
    }

    func testDeletionRequestMatchesCurrentServerWithoutExpiry() throws {
        let envelope = try JSONDecoder().decode(
            DeletionRequestEnvelope.self,
            from: Data(#"{"deletionRequest":{"requestId":"delete-1","userId":"user-1","email":"owner@example.com","requiredText":"DELETE MY ACCOUNT","steps":["Export records","Confirm deletion"]}}"#.utf8)
        )

        XCTAssertEqual(envelope.deletionRequest.requestId, "delete-1")
        XCTAssertNil(envelope.deletionRequest.expiresAt)
    }

    @MainActor
    func testCommandSafetyGatesReadinessAndStalenessButKeepsProtectiveActions() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))
        let store = MobileStore(
            client: MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!),
            previewSnapshot: snapshot
        )

        XCTAssertFalse(store.canSubmit("strategy.run_once"))
        XCTAssertFalse(store.canSubmit("strategy.start"))
        XCTAssertTrue(store.canSubmit("strategy.stop"))
        XCTAssertTrue(store.canSubmit("proposal.reject"))
        XCTAssertFalse(store.canSubmit("proposal.approve", at: Date(timeIntervalSinceNow: 181)))
    }

    func testSnapshotDefaultsOptionalCollectionsAndSummaries() throws {
        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))

        XCTAssertTrue(snapshot.positions.isEmpty)
        XCTAssertTrue(snapshot.orders.isEmpty)
        XCTAssertTrue(snapshot.connectedAccounts.isEmpty)
        XCTAssertTrue(snapshot.alerts.isEmpty)
        XCTAssertEqual(snapshot.marketSession, "unknown")
        XCTAssertEqual(snapshot.dailyStats.orderCount, 0)
        XCTAssertNil(snapshot.scheduler.nextRunAt)
    }

    func testSSEAccumulatorDispatchesOncePerPayloadFrame() {
        var parser = SSEFrameAccumulator()
        let lines = [
            ": connected",
            "",
            "event: mobile.command",
            "data: {\"id\":\"one\"}",
            "",
            "event: dashboard.refresh",
            "data: {}",
            "",
            ": ping",
            ""
        ]

        let dispatches = lines.reduce(into: 0) { count, line in
            if parser.consume(line: line) { count += 1 }
        }

        XCTAssertEqual(dispatches, 2)
    }

    func testLiveApprovalPayloadMatchesBackendContract() {
        let confirmation = LiveApprovalConfirmation(
            proposalId: "proposal-1",
            accountNumber: nil,
            estimatedNotional: nil,
            typedText: "APPROVE LIVE AAPL"
        )

        XCTAssertEqual(confirmation.jsonObject["proposalId"] as? String, "proposal-1")
        XCTAssertEqual(confirmation.jsonObject["executionMode"] as? String, "broker/live")
        XCTAssertEqual(confirmation.jsonObject["typedText"] as? String, "APPROVE LIVE AAPL")
        XCTAssertNil(confirmation.jsonObject["accountNumber"])
        XCTAssertTrue(confirmation.jsonObject["estimatedNotional"] is NSNull)
    }

    func testLiveConfirmationPhraseNormalizesSymbol() {
        XCTAssertEqual(liveApprovalConfirmationText(forSymbol: " aapl "), "APPROVE LIVE AAPL")
    }

    func testCommandAttemptTrackerReusesOnlyTheSameUnresolvedAction() {
        var tracker = CommandAttemptTracker()
        let first = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-1",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-1"]
        )
        let retry = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-1",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-1"]
        )
        let changedIntent = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-1",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-2"]
        )

        XCTAssertEqual(first, retry)
        XCTAssertNotEqual(first, changedIntent)

        tracker.release(operationID: "proposal.approve:proposal-1")
        let resolvedThenRetried = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-1",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-1"]
        )
        XCTAssertNotEqual(first, resolvedThenRetried)
    }

    private let minimalSnapshotJSON = #"""
    {
      "readiness": {
        "hasAccount": false,
        "hasUniverse": false,
        "systemState": "halted",
        "strategyAuthority": "propose",
        "selectedAccountNumber": null,
        "activeConnectedAccount": null,
        "commandBacklog": {"queued": 0, "running": 0}
      },
      "policy": {
        "systemState": "halted",
        "strategyAuthority": "propose"
      }
    }
    """#

    private let fullSnapshotJSON = #"""
    {
      "currentUser": {"userId":"user-1","email":"owner@example.com","name":"Owner","loginProvider":"apple","isAdmin":true},
      "readiness": {
        "hasAccount":true,
        "hasUniverse":true,
        "systemState":"active",
        "strategyAuthority":"propose",
        "selectedAccountNumber":"account-number",
        "activeConnectedAccount":{"id":"account-1","label":"Brokerage","broker":"robinhood","environment":"live","accountNumber":"account-number","isActive":true},
        "commandBacklog":{"queued":0,"running":0}
      },
      "policy": {
        "systemState":"active",
        "strategyAuthority":"propose",
        "accountNumber":"account-number",
        "connectedAccountId":"account-1",
        "includedIndices":["sp500"],
        "additionalSymbols":["AAPL"],
        "blocklist":[],
        "holdingHorizon":"swing",
        "runCadenceMinutes":30,
        "maxOrderNotional":2500,
        "maxOrderPctOfNav":5,
        "maxDailyNotional":10000,
        "maxDailyPctOfNav":20,
        "maxDailyOrders":8,
        "requireTypedConfirmation":true
      },
      "marketSession":"regular",
      "scheduler":{"lastRunAt":"2026-07-21T17:30:00.000Z","nextRunAt":"2026-07-21T18:00:00.000Z"},
      "portfolio":{"accountNumber":"account-number","totalMarketValue":25000,"buyingPower":7500,"equityMarketValue":20000,"optionMarketValue":0,"cash":5000},
      "positions":[{"symbol":"AAPL","quantity":10,"marketValue":2050,"averageCost":190,"sector":"Technology","industry":"Consumer Electronics"}],
      "orders":[{"id":"order-1","symbol":"AAPL","side":"buy","type":"limit","state":"filled","quantity":10,"filledQuantity":10,"averagePrice":190,"limitPrice":191,"timeInForce":"day","createdAt":"2026-07-21T15:00:00.000Z","updatedAt":"2026-07-21T15:01:00.000Z"}],
      "pendingProposals":[{"id":"proposal-1","createdAt":"2026-07-21T17:45:00.000Z","accountNumber":"account-number","executionMode":"broker/live","estimatedNotional":1500,"lastRevalidatedAt":"2026-07-21T17:50:00.000Z","revalidationNote":"Still valid","performanceSinceProposalPct":1.1,"proposalReferencePrice":200,"proposalCurrentPrice":202.2,"proposal":{"symbol":"AAPL","side":"buy","type":"limit","quantity":7,"limitPrice":201,"timeInForce":"day","rationale":"Rationale","greenTeamRationale":"Green rationale","tradeThesisTag":"quality","entryMarketRegime":"risk-on","confidenceScore":80,"proposedByModel":"openrouter/openai/gpt-5-mini","redTeamVerdict":{"verdict":"approve-at-half","rejected":false,"available":true,"reason":"Reduce concentration risk.","model":"openrouter/anthropic/claude-sonnet-4"}}}],
      "dailyStats":{"orderCount":2,"openingOrderCount":1,"notional":1500},
      "performance":{"liveRealizedPnl":125.5,"paperRealizedPnl":0,"liveUnrealizedPnl":40,"paperUnrealizedPnl":0,"liveWinRate":60,"paperWinRate":0,"liveAverageReturnPct":2.5,"paperAverageReturnPct":0,"benchmark":{"accountReturnPct":5.2,"benchmarkReturnPct":4,"excessReturnPct":1.2,"startDate":"2026-06-01","endDate":"2026-07-21","points":25,"benchmarkSymbol":"SPY","cashFlowAdjusted":true,"netExternalFlows":1000},"fills":[{"id":"fill-1","symbol":"AAPL","side":"buy","quantity":10,"price":190,"notional":1900,"status":"filled","filledAt":"2026-07-21T15:01:00.000Z"}]},
      "connectedAccounts":[{"id":"account-1","label":"Brokerage","broker":"robinhood","environment":"live","accountNumber":"account-number","isActive":true,"capabilities":{"equityTrading":true,"shortSelling":false,"optionsTrading":true,"optionsLevel":2,"marginEnabled":true,"accountType":"brokerage"}}],
      "watchlist":[{"symbol":"MSFT","addedAt":"2026-07-20T12:00:00.000Z"}],
      "alerts":[{"id":"alert-1","symbol":"AAPL","op":">","price":200,"note":"Breakout","status":"triggered","createdAt":"2026-07-20T12:00:00.000Z","triggeredAt":"2026-07-21T15:00:00.000Z","triggeredPrice":205}],
      "recentCommands":[{"id":"command-1","commandType":"strategy.run_once","status":"succeeded","error":null,"createdAt":"2026-07-21T17:30:00.000Z","queuedAt":"2026-07-21T17:30:00.000Z","startedAt":"2026-07-21T17:30:01.000Z","finishedAt":"2026-07-21T17:31:00.000Z","updatedAt":"2026-07-21T17:31:00.000Z"}]
    }
    """#
}
