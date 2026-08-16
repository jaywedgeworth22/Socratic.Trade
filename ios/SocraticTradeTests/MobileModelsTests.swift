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

    func testDeletionPreviewMatchesReadOnlyServerContract() throws {
        let envelope = try JSONDecoder().decode(
            DeletionRequestEnvelope.self,
            from: Data(#"{"deletionRequest":{"userId":"user-1","email":"owner@example.com","requiredText":"DELETE MY ACCOUNT","steps":["Export records","Confirm deletion"]}}"#.utf8)
        )

        XCTAssertNil(envelope.deletionRequest.requestId)
        XCTAssertNil(envelope.deletionRequest.expiresAt)
    }

    func testDeletionResultDecodesActualServerReceiptWithoutDeletedUserId() throws {
        let result = try JSONDecoder().decode(
            AccountDeletionResult.self,
            from: Data(#"{"ok":true,"counts":{"alerts":2,"connected_accounts":1},"logoutUrl":"/logout"}"#.utf8)
        )

        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.counts["alerts"], 2)
        XCTAssertEqual(result.logoutUrl, "/logout")
    }

    func testLegacyRedTeamVerdictsDecodeWithSafeDefaults() throws {
        let legacyObject = try JSONDecoder().decode(
            RedTeamVerdict.self,
            from: Data(#"{"decision":"reject","rationale":"Legacy objection"}"#.utf8)
        )
        let legacyString = try JSONDecoder().decode(
            RedTeamVerdict.self,
            from: Data(#""approve""#.utf8)
        )
        let emptyObject = try JSONDecoder().decode(
            RedTeamVerdict.self,
            from: Data(#"{}"#.utf8)
        )
        let oldestPersistedVerdict = try JSONDecoder().decode(
            RedTeamVerdict.self,
            from: Data(#"{"rejected":true}"#.utf8)
        )

        XCTAssertEqual(legacyObject.verdict, "reject")
        XCTAssertTrue(legacyObject.rejected)
        XCTAssertTrue(legacyObject.available)
        XCTAssertEqual(legacyObject.reason, "Legacy objection")
        XCTAssertEqual(legacyString.verdict, "approve")
        XCTAssertTrue(legacyString.available)
        XCTAssertFalse(emptyObject.available)
        XCTAssertFalse(emptyObject.rejected)
        XCTAssertFalse(emptyObject.reason.isEmpty)
        XCTAssertTrue(oldestPersistedVerdict.available)
        XCTAssertTrue(oldestPersistedVerdict.rejected)
    }

    func testPresentedMarketItemIdentifiesFillPositionAndCompany() throws {
        let fill = try JSONDecoder().decode(
            FillEvent.self,
            from: Data(#"{"id":"fill-1","symbol":"GOOG","side":"buy","quantity":2,"price":343.94,"notional":687.88,"status":"filled","filledAt":"2026-08-13T20:00:00.000Z"}"#.utf8)
        )
        let position = try JSONDecoder().decode(
            Position.self,
            from: Data(#"{"symbol":"GOOG","quantity":10,"marketValue":3439.4,"averageCost":300,"sector":"Technology","industry":"Internet Content & Information"}"#.utf8)
        )
        let quote = try JSONDecoder().decode(
            SymbolQuoteInfo.self,
            from: Data(#"{"symbol":"GOOG","companyName":"Alphabet Inc.","price":343.94,"peRatio":26.4,"eps":10.12,"dividendYield":0.32,"beta":1.01,"fiftyTwoWeekHigh":404.47,"fiftyTwoWeekLow":197.46}"#.utf8)
        )

        XCTAssertEqual(PresentedMarketItem.company("GOOG").id, "company:GOOG")
        XCTAssertEqual(PresentedMarketItem.fill(fill).id, "fill:fill-1")
        XCTAssertEqual(PresentedMarketItem.position(position).id, "position:GOOG")
        XCTAssertEqual(PresentedMarketItem.fill(fill).symbol, "GOOG")
        XCTAssertEqual(PresentedMarketItem.position(position).symbol, "GOOG")
        XCTAssertEqual(PresentedMarketItem.fill(fill).fill?.id, "fill-1")
        XCTAssertNil(PresentedMarketItem.company("GOOG").fill)
        XCTAssertEqual(PresentedMarketItem.position(position).position?.quantity, 10)
        XCTAssertEqual(quote.fiftyTwoWeekHigh, 404.47)
        XCTAssertEqual(quote.peRatio, 26.4)
        XCTAssertEqual(AppFormat.peRatioDisplay(peRatio: quote.peRatio, eps: quote.eps), "26.4")
        XCTAssertEqual(AppFormat.peRatioDisplay(peRatio: nil, eps: -1), "n/a")
        XCTAssertEqual(AppFormat.peRatioDisplay(peRatio: nil, eps: nil), "—")

        let desk = try JSONDecoder().decode(
            SymbolDeskInfo.self,
            from: Data(#"{"symbol":"GOOG","peerAccounts":[{"accountId":"ira","label":"Roth IRA","environment":"live","direction":"long","quantity":4}],"exit":{"style":"trailing","stopPrice":300,"takeProfitPrice":420,"trailPercent":6},"pending":[{"id":"p1","side":"buy","quantity":1,"rationale":"green team: still a hold"}]}"#.utf8)
        )
        XCTAssertEqual(desk.peerAccounts.first?.quantity, 4)
        XCTAssertEqual(desk.peerAccounts.first?.direction, "long")
        XCTAssertEqual(desk.exit?.style, "trailing")
        XCTAssertEqual(desk.pending.first?.side, "buy")
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
        // Account switch stays available even when the snapshot is stale — it is metadata-only
        // and the server executes it immediately outside the strategy.run_once queue.
        XCTAssertTrue(store.canSubmit("account.activate", at: Date(timeIntervalSinceNow: 181)))
        XCTAssertTrue(store.canSubmit("account.activate"))
        // Cancel is exempt too, and for a sharper reason: a stale snapshot usually means a flaky
        // connection, which is exactly when someone reaches for cancel.  Gating it there would
        // withhold the one lever that only ever reduces risk.  The server re-validates the order
        // (`requireWorkingOrder: true` → 404/409), so a stale tap collects an honest error rather
        // than cancelling the wrong thing.
        XCTAssertTrue(store.canSubmit("order.cancel", at: Date(timeIntervalSinceNow: 181)))
        XCTAssertTrue(store.canSubmit("order.cancel"))
        // Readiness gating is untouched by the exemption: this fixture has no account and no
        // universe, and the readiness-dependent commands above still refuse.
        XCTAssertFalse(store.canSubmit("strategy.run_once", at: Date(timeIntervalSinceNow: 181)))
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

    func testCloudflareOriginDownErrorsAreUserReadable() {
        let error = MobileAPIError.serverError(statusCode: 522, message: nil)
        let text = error.errorDescription ?? ""
        XCTAssertTrue(text.contains("522"), text)
        XCTAssertTrue(text.contains("unreachable") || text.contains("Cloudflare"), text)
    }

    func testEventsRequestUsesSSEAcceptAndLongTimeout() {
        let client = MobileAPIClient(baseURL: URL(string: "https://socratictrade.com")!)
        let request = client.eventsRequest()

        XCTAssertEqual(request.url?.path, "/api/mobile/events")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "accept"), "text/event-stream")
        XCTAssertEqual(request.value(forHTTPHeaderField: "cache-control"), "no-cache")
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, 90)
        XCTAssertNotEqual(request.value(forHTTPHeaderField: "accept"), "application/json")
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

    // Rewritten 2026-08-12: this test predates the test target ever being RUNNABLE (a
    // TEST_HOST mismatch plus a module-name mismatch meant it had never executed), and
    // its original tail was authored against an imagined tracker that kept one attempt
    // per fingerprint.  The real tracker deliberately keeps ONE attempt per operationID
    // (a changed intent under the same operation REPLACES the old attempt — the old key
    // must never be reused for a different payload), while double-submit protection for
    // in-flight operations lives a layer up in MobileStore.busyOperations.  The
    // assertions below pin the real, safe semantics.
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
        // Same operation, same intent: the key is reused so the server dedupes retries.
        XCTAssertEqual(first, retry)

        // A queued (non-terminal) command keeps the attempt alive: no resolution is
        // emitted and the key still dedupes further retries of the same intent.
        let queued = decodeCommand(
            #"{"id":"command-1","commandType":"proposal.approve","status":"queued","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:30:00.000Z"}"#
        )
        tracker.track(queued, operationID: "proposal.approve:proposal-1")
        XCTAssertTrue(tracker.reconcile([queued]).isEmpty)
        XCTAssertEqual(
            first,
            tracker.idempotencyKey(
                operationID: "proposal.approve:proposal-1",
                commandType: "proposal.approve",
                payload: ["proposalId": "proposal-1"]
            )
        )

        // Changed intent under the same operation must NOT reuse the old key — the
        // stale attempt is replaced outright (one attempt per operationID).
        let changedIntent = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-1",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-2"]
        )
        XCTAssertNotEqual(first, changedIntent)

        // A distinct operation tracks independently and resolves on its terminal
        // command; the resolved attempt is released, so a later retry of that same
        // operation mints a FRESH key (a retry after failure is a new command — the
        // server must not dedupe-swallow it).
        let secondOp = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-9",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-9"]
        )
        let failed = decodeCommand(
            #"{"id":"command-9","commandType":"proposal.approve","status":"failed","error":"Proposal expired","createdAt":"2026-07-21T17:30:00.000Z","updatedAt":"2026-07-21T17:31:00.000Z"}"#
        )
        tracker.track(failed, operationID: "proposal.approve:proposal-9")
        XCTAssertEqual(
            tracker.reconcile([failed]),
            [CommandAttemptTracker.Resolution(
                operationID: "proposal.approve:proposal-9",
                status: "failed",
                error: "Proposal expired"
            )]
        )
        let resolvedThenRetried = tracker.idempotencyKey(
            operationID: "proposal.approve:proposal-9",
            commandType: "proposal.approve",
            payload: ["proposalId": "proposal-9"]
        )
        XCTAssertNotEqual(secondOp, resolvedThenRetried)
    }

    @MainActor
    func testSuccessfulDeletionHTTPAlwaysClearsLocalSessionWhenOptionalReceiptFieldsDrift() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MobileTestURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer {
            MobileTestURLProtocol.handler = nil
            session.invalidateAndCancel()
        }

        MobileTestURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["content-type": "application/json"]
            )!
            if request.url?.path == "/api/mobile/account-deletion/request" {
                XCTAssertEqual(request.httpMethod, "GET")
                return (
                    response,
                    Data(#"{"deletionRequest":{"userId":"user-1","email":"owner@example.com","requiredText":"DELETE MY ACCOUNT","steps":["Confirm deletion"]}}"#.utf8)
                )
            }
            XCTAssertEqual(request.url?.path, "/api/mobile/account-deletion/confirm")
            XCTAssertEqual(request.httpMethod, "POST")
            // Current server fields are present, deletedUserId is intentionally absent, and the
            // optional logout URL is omitted to exercise the local fallback.
            return (response, Data(#"{"ok":true,"counts":{"alerts":1},"futureField":"ignored"}"#.utf8))
        }

        let snapshot = try JSONDecoder().decode(MobileSnapshot.self, from: Data(minimalSnapshotJSON.utf8))
        let store = MobileStore(
            client: MobileAPIClient(
                baseURL: URL(string: "https://socratictrade.com")!,
                session: session
            ),
            previewSnapshot: snapshot
        )

        await store.loadAccountDeletionPreview()
        XCTAssertNotNil(store.deletionRequest)
        let logoutURL = await store.confirmAccountDeletion(
            typedIdentity: "owner@example.com",
            typedText: "DELETE MY ACCOUNT"
        )

        XCTAssertFalse(store.isAuthenticated)
        XCTAssertNil(store.snapshot)
        XCTAssertEqual(logoutURL?.absoluteString, "https://socratictrade.com/logout")
    }

    private func decodeCommand(_ json: String) -> MobileCommand {
        try! JSONDecoder().decode(MobileCommand.self, from: Data(json.utf8))
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

private final class MobileTestURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
