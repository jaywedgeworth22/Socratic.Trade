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
          "asOf":"2026-08-13T15:00:00.000Z"
        }
        """#.utf8)
        let scan = try JSONDecoder().decode(MarketScanResponse.self, from: json)
        XCTAssertEqual(scan.topCandidates.count, 2)
        XCTAssertEqual(scan.topCandidates[0].symbol, "AAPL")
        XCTAssertEqual(scan.topCandidates[0].price, 210.5)
        XCTAssertEqual(scan.topCandidates[1].symbol, "MSFT")
        XCTAssertNil(scan.topCandidates[1].price)
        XCTAssertEqual(scan.asOf, "2026-08-13T15:00:00.000Z")
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
        XCTAssertEqual(DeskCopy.modelSeatValue("__rotate__"), "Rotating")
        XCTAssertEqual(DeskCopy.modelSeatValue(" __ROTATE__ "), "Rotating")
        XCTAssertEqual(
            DeskCopy.modelSeatValue("__rotate__", fallbacks: ["google/gemini-3.7-flash"]),
            "google/gemini-3.7-flash"
        )
        XCTAssertEqual(DeskCopy.modelSeatValue("claude-sonnet-5"), "claude-sonnet-5")
        XCTAssertEqual(DeskCopy.modelSeatValue(nil), "—")
        XCTAssertFalse(DeskCopy.modelSeatValue("__rotate__").contains("__"))
    }

    func testJoinedListAndYesNoAreSentenceCaseValues() {
        XCTAssertEqual(DeskCopy.joinedList(["QQQ", "SPY"]), "QQQ, SPY")
        XCTAssertEqual(DeskCopy.joinedList([]), "none")
        XCTAssertEqual(DeskCopy.yesNo(true), "yes")
        XCTAssertEqual(DeskCopy.yesNo(nil), "—")
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
