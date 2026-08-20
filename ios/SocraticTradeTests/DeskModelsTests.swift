import XCTest
@testable import SocraticTrade

final class DeskModelsTests: XCTestCase {
    func testCoachProviderRoutingMatchesChatCatalog() {
        XCTAssertEqual(CoachModelCatalog.provider(for: "claude-sonnet-5"), "anthropic")
        XCTAssertEqual(CoachModelCatalog.provider(for: "grok-4.5"), "xai")
        XCTAssertEqual(CoachModelCatalog.provider(for: "gemini-flash-latest"), "gemini")
        XCTAssertEqual(CoachModelCatalog.provider(for: "gpt-5.4-mini"), "openai")
        XCTAssertEqual(CoachModelCatalog.provider(for: "mock"), "mock")
    }

    func testFirstAvailablePrefersAKeyedProviderThenMock() {
        XCTAssertEqual(
            CoachModelCatalog.firstAvailable(providers: ["anthropic": true])?.id,
            "claude-haiku-4.5"
        )
        XCTAssertEqual(
            CoachModelCatalog.firstAvailable(providers: [:])?.id,
            "mock"
        )
    }

    func testAuthorityCopyNeverCallsAutopilotARunState() {
        let copy = DeskCopy.authorityVersusRunState(authority: "decide", runState: .pausedMarketClosed)
        XCTAssertTrue(copy.contains("Autopilot"))
        XCTAssertTrue(copy.contains("Paused · market closed"))
        XCTAssertFalse(copy.contains("Autopilot is Running"))
    }

    func testScanCandidateDecodesSparseRows() throws {
        let json = Data(#"""
        {
          "topCandidates": [
            {"symbol":"AAPL","price":210.5,"score":81.2,"intradayChangePct":1.4,"sector":"Technology"},
            {"symbol":"MSFT"}
          ],
          "asOf":"2026-08-13T15:00:00.000Z",
          "scannedSymbols": 503,
          "returnedQuotes": 498,
          "warnings": ["The delayed screener returned no quotes; the quote fallback priced 498 of 503 names."]
        }
        """#.utf8)
        let scan = try JSONDecoder().decode(MarketScanResponse.self, from: json)
        XCTAssertEqual(scan.topCandidates.count, 2)
        XCTAssertEqual(scan.topCandidates[0].symbol, "AAPL")
        XCTAssertEqual(scan.topCandidates[0].price, 210.5)
        XCTAssertEqual(scan.topCandidates[1].symbol, "MSFT")
        XCTAssertNil(scan.topCandidates[1].price)
        XCTAssertEqual(scan.asOf, "2026-08-13T15:00:00.000Z")
        XCTAssertEqual(scan.scannedSymbols, 503)
        XCTAssertEqual(scan.returnedQuotes, 498)
        XCTAssertEqual(scan.warnings.count, 1)
        XCTAssertEqual(
            DeskCopy.scanCountLine(names: 2, scanned: scan.scannedSymbols, quotes: scan.returnedQuotes, watched: 2),
            "2 names · 503 scanned · 498 quotes · 2 watched"
        )
    }

    func testScanQuotesUnavailable503DecodesAbortReceipt() throws {
        let json = Data(#"""
        {
          "error": "Quotes were unavailable for this universe.  Refresh after the quote feed recovers.",
          "code": "scan_quotes_unavailable",
          "scannedSymbols": 505,
          "returnedQuotes": 0,
          "warnings": [
            "This operation was aborted",
            "Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback."
          ],
          "topCandidates": []
        }
        """#.utf8)
        let scan = try JSONDecoder().decode(MarketScanResponse.self, from: json)
        XCTAssertEqual(scan.scannedSymbols, 505)
        XCTAssertEqual(scan.returnedQuotes, 0)
        XCTAssertEqual(scan.topCandidates.count, 0)
        XCTAssertEqual(scan.warnings.first, "This operation was aborted")
        XCTAssertEqual(
            DeskCopy.scanCountLine(names: 0, scanned: scan.scannedSymbols, quotes: scan.returnedQuotes, watched: 2),
            "0 names · 505 scanned · 0 quotes · 2 watched"
        )
        let error = MobileAPIError.scanQuotesUnavailable(scan)
        XCTAssertEqual(error.errorDescription, "This operation was aborted")
        XCTAssertFalse((error.errorDescription ?? "").localizedCaseInsensitiveContains("Guardrails"))
        XCTAssertFalse((error.errorDescription ?? "").localizedCaseInsensitiveContains("No Candidates"))

        let joinedJSON = Data(#"""
        {
          "scannedSymbols": 505,
          "returnedQuotes": 0,
          "warnings": [
            "This operation was aborted",
            "Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback."
          ],
          "topCandidates": []
        }
        """#.utf8)
        let joinedScan = try JSONDecoder().decode(MarketScanResponse.self, from: joinedJSON)
        let joined = MobileAPIError.scanQuotesUnavailable(joinedScan)
        XCTAssertEqual(
            joined.errorDescription,
            "This operation was aborted  Live Nasdaq screener data was unavailable; showing the latest completed strategy scan as a stale fallback."
        )
    }

    func testFailedRefreshKeepsLastGoodUniverse() {
        let lastGood = MarketScanResponse(
            topCandidates: [
                ScanCandidate(symbol: "BRK-B", companyName: "Berkshire Hathaway", price: 500, score: 88),
                ScanCandidate(symbol: "GOOG", price: 180, score: 86)
            ],
            asOf: "2026-08-18T19:25:13.000Z",
            generatedAt: "2026-08-18T19:25:13.000Z",
            scannedSymbols: 5073,
            returnedQuotes: 5069
        )
        let failed = MarketScanResponse(
            topCandidates: [],
            scannedSymbols: 5073,
            returnedQuotes: 0,
            warnings: ["This operation was aborted"]
        )
        let kept = failed.keepingLastGood(from: lastGood)
        XCTAssertEqual(kept.topCandidates.map(\.symbol), ["BRK-B", "GOOG"])
        XCTAssertEqual(kept.scannedSymbols, 5073)
        XCTAssertTrue(lastGood.hasUsableUniverse)
        XCTAssertFalse(failed.hasUsableUniverse)

        let banner = DeskCopy.scanRefreshFailedBanner(
            reason: MobileAPIError.serverError(statusCode: 503, message: nil).errorDescription ?? "",
            lastGoodAt: lastGood.lastGoodStamp
        )
        XCTAssertTrue(banner.contains("Showing the last good scan from"))
        XCTAssertFalse(banner.contains("503"))
        XCTAssertFalse(banner.lowercased().contains("http"))
    }

    func testChatTurnAndSourceValueDecode() throws {
        let turn = try JSONDecoder().decode(
            ChatTurn.self,
            from: Data(#"{"role":"assistant","text":"Hello","citations":["10-K"]}"#.utf8)
        )
        XCTAssertFalse(turn.isUser)
        XCTAssertEqual(turn.text, "Hello")
        XCTAssertEqual(turn.citations, ["10-K"])

        XCTAssertEqual(
            try JSONDecoder().decode(SourceSettingValue.self, from: Data("true".utf8)),
            .bool(true)
        )
        XCTAssertEqual(
            try JSONDecoder().decode(SourceSettingValue.self, from: Data("12".utf8)),
            .number(12)
        )
        XCTAssertEqual(
            try JSONDecoder().decode(SourceSettingValue.self, from: Data("null".utf8)),
            .none
        )
        XCTAssertEqual(
            try JSONDecoder().decode(SourceSettingValue.self, from: Data("12".utf8)).numberValue,
            12
        )
    }

    func testLlmBudgetResponseDecodesNullCaps() throws {
        let json = Data(#"""
        {
          "ok": true,
          "tokenBudget": null,
          "costBudgetUsd": 12.5,
          "effective": {
            "tokenLimit": null,
            "costLimitUsd": 12.5,
            "tokenSource": "none",
            "costSource": "user"
          },
          "today": { "tokens": 800, "costUsd": 1.25 },
          "enforced": true
        }
        """#.utf8)
        let budget = try JSONDecoder().decode(LlmBudgetResponse.self, from: json)
        XCTAssertNil(budget.tokenBudget)
        XCTAssertEqual(budget.costBudgetUsd, 12.5)
        XCTAssertEqual(budget.today.tokens, 800)
        XCTAssertTrue(budget.enforced)
        XCTAssertEqual(budget.effective.costSource, "user")
    }

    func testIraWashSaleCopyMatchesWebNA() {
        XCTAssertTrue(DeskCopy.isIraTaxation("roth_ira"))
        XCTAssertTrue(DeskCopy.isIraTaxation(" traditional_ira "))
        XCTAssertTrue(DeskCopy.isIraTaxation("Roth IRA"))
        XCTAssertTrue(DeskCopy.isIraTaxation("Traditional IRA"))
        XCTAssertFalse(DeskCopy.isIraTaxation("taxable"))
        XCTAssertFalse(DeskCopy.isIraTaxation("brokerage"))
        XCTAssertTrue(
            DeskCopy.isIraAccount(
                accountTaxation: nil,
                capabilityType: "brokerage",
                policyTaxation: "roth_ira"
            )
        )

        XCTAssertEqual(
            DeskCopy.resolvedTaxationType(
                accountTaxation: "roth_ira",
                capabilityType: "brokerage",
                policyTaxation: "taxable"
            ),
            "roth_ira"
        )

        let disregarded = DeskCopy.iraWashSaleRows(handling: "disregard")
        XCTAssertEqual(disregarded.sameAccount, "not applicable")
        XCTAssertEqual(disregarded.crossAccount, "ignored")

        let blocked = DeskCopy.iraWashSaleRows(handling: "block")
        XCTAssertEqual(blocked.sameAccount, "not applicable")
        XCTAssertEqual(blocked.crossAccount, "blocked")

        let missing = DeskCopy.iraWashSaleRows(handling: nil)
        XCTAssertEqual(missing.crossAccount, "ignored")
    }

    func testFullPolicyDecodesIraWashSaleHandling() throws {
        let json = Data(#"""
        {
          "taxSettings": {
            "taxationType": "roth_ira",
            "washSaleGuard": true,
            "washSaleHandling": "block",
            "iraWashSaleHandling": "disregard",
            "shortTermRatePct": 24,
            "longTermRatePct": 15
          }
        }
        """#.utf8)
        let policy = try JSONDecoder().decode(FullPolicy.self, from: json)
        XCTAssertEqual(policy.taxSettings?.taxationType, "roth_ira")
        XCTAssertEqual(policy.taxSettings?.iraWashSaleHandling, "disregard")
        XCTAssertTrue(DeskCopy.isIraTaxation(policy.taxSettings?.taxationType))
    }

    func testModelSeatValueNeverShowsTheRotateSentinel() {
        XCTAssertEqual(DeskCopy.modelSeatValue("__rotate__"), "rotate models")
        XCTAssertEqual(DeskCopy.modelSeatValue(" __ROTATE__ "), "rotate models")
        XCTAssertEqual(
            DeskCopy.modelSeatValue("__rotate__", fallbacks: ["google/gemini-3.7-flash"]),
            "rotate models"
        )
        XCTAssertEqual(DeskCopy.modelSeatValue("claude-sonnet-5"), "claude-sonnet-5")
        XCTAssertEqual(DeskCopy.modelSeatValue(nil), "—")
        XCTAssertFalse(DeskCopy.modelSeatValue("__rotate__").contains("_"))
        XCTAssertFalse(DeskCopy.modelSeatValue("__rotate__").contains("rotate__"))
    }

    func testJoinedListAndYesNoAreSentenceCaseValues() {
        XCTAssertEqual(DeskCopy.joinedList(["QQQ", "SPY"]), "QQQ, SPY")
        XCTAssertEqual(DeskCopy.joinedList([]), "none")
        XCTAssertEqual(DeskCopy.yesNo(true), "yes")
        XCTAssertEqual(DeskCopy.yesNo(nil), "—")
    }

    func testIndexUniverseLabelsMatchTheWebMapAndNeverShowSlugs() {
        let expected: [(String, String)] = [
            ("sp100", "S&P 100"),
            ("sp500", "S&P 500"),
            ("nasdaq100", "Nasdaq 100"),
            ("nasdaqComposite", "Nasdaq Composite"),
            ("dow30", "Dow 30"),
            ("russell2000", "Russell 2000"),
            ("nyseComposite", "NYSE Composite"),
            ("ftWilshire5000", "FT Wilshire 5000")
        ]
        XCTAssertEqual(DeskCopy.indexUniverseLabels.count, expected.count)
        for (slug, label) in expected {
            XCTAssertEqual(DeskCopy.indexUniverseLabel(slug), label)
            XCTAssertNotEqual(label, slug)
        }
        XCTAssertEqual(DeskCopy.joinedIndexList(["sp500", "russell2000"]), "S&P 500, Russell 2000")
        XCTAssertTrue(DeskCopy.universeNeedsIndex.contains("S&P 500"))
        XCTAssertFalse(DeskCopy.universeNeedsIndex.contains("Strategy page"))
        XCTAssertEqual(
            DeskCopy.joinedIndexList(["sp500", "nasdaqComposite", "dow30", "nyseComposite"]),
            "S&P 500, Nasdaq Composite, Dow 30, NYSE Composite"
        )
        XCTAssertEqual(DeskCopy.joinedIndexList(["sp500", "not-an-index"]), "S&P 500")
        XCTAssertEqual(DeskCopy.joinedIndexList([]), "none")
        XCTAssertEqual(DeskCopy.joinedIndexList(["mysteryIndex"]), "none")
        XCTAssertFalse(DeskCopy.joinedIndexList(["sp500", "nasdaq100"]).contains("sp500"))
        XCTAssertFalse(DeskCopy.joinedIndexList(["sp500", "nasdaq100"]).contains("nasdaq100"))
    }

    func testNewTabsStayCustomizableAndMoreDoesNot() {
        for tab in [AppTab.coach, .scan, .guardrails, .results] {
            XCTAssertTrue(AppTab.customizable.contains(tab), "\(tab)")
        }
        XCTAssertFalse(AppTab.customizable.contains(.more))
        XCTAssertEqual(AppTab.coach.title, "Coach")
        XCTAssertEqual(AppTab.scan.title, "Scan")
        XCTAssertEqual(AppTab.guardrails.title, "Guardrails")
        XCTAssertEqual(AppTab.results.title, "Results")
    }
}
