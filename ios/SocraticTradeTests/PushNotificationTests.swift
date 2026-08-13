import UserNotifications
import XCTest
@testable import SocraticTrade

/// The parts of push that can be wrong silently: which APNs environment a token belongs to,
/// what gets sent to the server, and what a payload means.  `UNUserNotificationCenter` itself
/// is not unit-testable, so everything that decides an outcome is pulled out into pure
/// functions and pinned here.
final class APNSEnvironmentTests: XCTestCase {
    func testDevelopmentSigningMeansSandbox() {
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "development", isSimulator: false),
            .sandbox
        )
    }

    /// The bug this whole type exists to prevent: TestFlight is a Release build signed with a
    /// DISTRIBUTION profile, whose aps-environment is `production`.  Treating it as sandbox
    /// makes every push 400 BadDeviceToken with no visible error anywhere.
    func testDistributionSigningMeansProductionIncludingTestFlight() {
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "production", isSimulator: false),
            .production
        )
    }

    func testUnreadableProfileOnADeviceFallsBackToProduction() {
        // A shipped build is the only realistic reason a device cannot read its own profile,
        // and shipped builds are production.  Guessing sandbox here would be the silent
        // failure again.
        XCTAssertEqual(APNSEnvironment.resolve(entitlementValue: nil, isSimulator: false), .production)
        XCTAssertEqual(APNSEnvironment.resolve(entitlementValue: "", isSimulator: false), .production)
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "something-else", isSimulator: false),
            .production
        )
    }

    func testSimulatorIsAlwaysSandboxWhateverItWasSignedWith() {
        // The simulator gets no real APNs token, so it must never claim a production
        // registration the server would then try to push to.
        XCTAssertEqual(APNSEnvironment.resolve(entitlementValue: "production", isSimulator: true), .sandbox)
        XCTAssertEqual(APNSEnvironment.resolve(entitlementValue: nil, isSimulator: true), .sandbox)
    }

    func testEntitlementValueIsReadLenientlyForCaseAndWhitespace() {
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "  Development \n", isSimulator: false),
            .sandbox
        )
        XCTAssertEqual(
            APNSEnvironment.resolve(entitlementValue: "PRODUCTION", isSimulator: false),
            .production
        )
    }

    // MARK: - Provisioning-profile parsing

    /// `embedded.mobileprovision` is a CMS envelope with an XML plist buried inside, so the
    /// parser has to find the plist between binary signature bytes on both sides.
    private func wrappedProfile(entitlements: String) -> Data {
        var data = Data([0x30, 0x82, 0x0A, 0xBC, 0x00, 0xFF])
        data.append(Data("""
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Name</key>
            <string>Socratic Trade</string>
            <key>Entitlements</key>
            <dict>
        \(entitlements)
            </dict>
        </dict>
        </plist>
        """.utf8))
        data.append(Data([0x00, 0x01, 0x02, 0xFE]))
        return data
    }

    func testReadsApsEnvironmentOutOfAWrappedProfile() {
        let profile = wrappedProfile(entitlements: """
                    <key>aps-environment</key>
                    <string>production</string>
        """)
        XCTAssertEqual(APNSEnvironment.apsEnvironment(inProvisioningProfile: profile), "production")
    }

    func testReadsDevelopmentProfiles() {
        let profile = wrappedProfile(entitlements: """
                    <key>application-identifier</key>
                    <string>CC8UTF7ATG.trade.socratic.app</string>
                    <key>aps-environment</key>
                    <string>development</string>
        """)
        XCTAssertEqual(APNSEnvironment.apsEnvironment(inProvisioningProfile: profile), "development")
        XCTAssertEqual(
            APNSEnvironment.resolve(
                entitlementValue: APNSEnvironment.apsEnvironment(inProvisioningProfile: profile),
                isSimulator: false
            ),
            .sandbox
        )
    }

    func testProfileWithoutPushCapabilityYieldsNil() {
        let profile = wrappedProfile(entitlements: """
                    <key>get-task-allow</key>
                    <true/>
        """)
        XCTAssertNil(APNSEnvironment.apsEnvironment(inProvisioningProfile: profile))
    }

    func testGarbageAndEmptyDataYieldNilRatherThanCrashing() {
        XCTAssertNil(APNSEnvironment.apsEnvironment(inProvisioningProfile: Data()))
        XCTAssertNil(APNSEnvironment.apsEnvironment(inProvisioningProfile: Data([0x00, 0xFF, 0x10])))
        XCTAssertNil(
            APNSEnvironment.apsEnvironment(inProvisioningProfile: Data("<plist not really".utf8))
        )
    }
}

final class PushRegistrationRequestTests: XCTestCase {
    func testDeviceTokenIsLowercaseHexWithoutSeparators() {
        let token = Data([0x00, 0x0f, 0xa1, 0xff, 0x10])
        XCTAssertEqual(PushRegistrationRequest.hexEncoded(token), "000fa1ff10")
    }

    func testFullLengthTokenRoundTripsToSixtyFourHexCharacters() {
        let request = PushRegistrationRequest(
            deviceToken: Data(repeating: 0xAB, count: 32),
            environment: .production,
            bundleId: "trade.socratic.app"
        )
        XCTAssertEqual(request?.token.count, 64)
        XCTAssertEqual(request?.token, String(repeating: "ab", count: 32))
    }

    func testEmptyTokenIsRefused() {
        // A blank token would become a server row that can never be delivered to and never
        // invalidated, because APNs never answers 410 for something it never issued.
        XCTAssertNil(
            PushRegistrationRequest(deviceToken: Data(), environment: .production, bundleId: "trade.socratic.app")
        )
    }

    func testBodyCarriesTokenEnvironmentAndBundleId() {
        let request = PushRegistrationRequest(
            token: "abc123",
            environment: .sandbox,
            bundleId: "trade.socratic.app"
        )
        XCTAssertEqual(
            request.jsonBody,
            ["token": "abc123", "environment": "sandbox", "bundleId": "trade.socratic.app"]
        )
    }

    func testEnvironmentIsSentAsTheWireStringsTheServerSwitchesOn() {
        XCTAssertEqual(APNSEnvironment.sandbox.rawValue, "sandbox")
        XCTAssertEqual(APNSEnvironment.production.rawValue, "production")
    }

    func testMissingBundleIdIsOmittedRatherThanSentEmpty() {
        XCTAssertEqual(
            PushRegistrationRequest(token: "abc123", environment: .production, bundleId: nil).jsonBody,
            ["token": "abc123", "environment": "production"]
        )
        XCTAssertEqual(
            PushRegistrationRequest(token: "abc123", environment: .production, bundleId: "   ").jsonBody,
            ["token": "abc123", "environment": "production"]
        )
    }
}

final class PushPayloadTests: XCTestCase {
    private func payload(_ object: [String: Any]) -> [AnyHashable: Any] {
        var userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "Proposal ready"], "badge": 1]]
        for (key, value) in object {
            userInfo[key] = value
        }
        return userInfo
    }

    func testReadsTheLinkFromTheAcceptedRootKeys() {
        for key in PushPayload.linkKeys {
            XCTAssertEqual(
                PushPayload.deepLinkURL(in: payload([key: "https://socratictrade.com/console/activity"]))?
                    .absoluteString,
                "https://socratictrade.com/console/activity",
                key
            )
        }
    }

    func testReadsTheLinkFromANestedDataObject() {
        XCTAssertEqual(
            PushPayload.destination(
                in: payload(["data": ["url": "https://socratictrade.com/console/approvals"]])
            ),
            .tab(.proposals)
        )
    }

    func testRootKeyWinsOverNestedData() {
        XCTAssertEqual(
            PushPayload.destination(
                in: payload([
                    "url": "https://socratictrade.com/console/activity",
                    "data": ["url": "https://socratictrade.com/console/orders"]
                ])
            ),
            .tab(.activity)
        )
    }

    func testProposalNotificationsCarryTheProposalThrough() {
        XCTAssertEqual(
            PushPayload.destination(
                in: payload(["url": "https://socratictrade.com/console/approvals/proposal-77"])
            ),
            .proposal(id: "proposal-77")
        )
    }

    func testPayloadWithoutALinkRoutesNowhere() {
        XCTAssertNil(PushPayload.deepLinkURL(in: payload([:])))
        XCTAssertNil(PushPayload.deepLinkURL(in: payload(["url": "   "])))
        XCTAssertNil(PushPayload.deepLinkURL(in: payload(["url": 42])))
        XCTAssertNil(PushPayload.destination(in: payload([:])))
    }

    /// The payload is data off the network, so a tap must not be able to drive the app
    /// anywhere `DeepLink` would not already send a universal link.  One router, one policy.
    func testUnroutableAndHostileLinksAreDroppedByTheSharedRouter() {
        XCTAssertNil(PushPayload.destination(in: payload(["url": "https://evil.example.com/console/approvals"])))
        XCTAssertNil(PushPayload.destination(in: payload(["url": "http://socratictrade.com/console/approvals"])))
        XCTAssertNil(PushPayload.destination(in: payload(["url": "socratictrade://console/approvals"])))
        XCTAssertNil(PushPayload.destination(in: payload(["url": "https://socratictrade.com/console/settings"])))
    }
}

final class PushPresentationTests: XCTestCase {
    /// While the SSE stream is up the screen already reflects the event, so a banner would
    /// restate what the owner is looking at.  It still reaches Notification Center and the
    /// badge, so nothing is lost.
    func testForegroundBannerIsSuppressedWhileTheLiveStreamIsUp() {
        let options = PushNotificationCoordinator.foregroundPresentationOptions(isLiveStreamConnected: true)
        XCTAssertFalse(options.contains(.banner))
        XCTAssertFalse(options.contains(.sound))
        XCTAssertTrue(options.contains(.list))
        XCTAssertTrue(options.contains(.badge))
    }

    /// With the stream down the screen is stale, so the notification is the only way the owner
    /// hears about it — suppressing it there would hide real news.
    func testForegroundBannerIsShownWhenTheLiveStreamIsDown() {
        let options = PushNotificationCoordinator.foregroundPresentationOptions(isLiveStreamConnected: false)
        XCTAssertTrue(options.contains(.banner))
        XCTAssertTrue(options.contains(.list))
        XCTAssertTrue(options.contains(.badge))
    }
}

final class PushAlertStateTests: XCTestCase {
    /// Only a completed server registration may read as working.  Everything else — including
    /// "the owner allowed it but no token arrived" — must not be presented as alerts being on.
    func testOnlyARegisteredTokenCountsAsWorking() {
        XCTAssertTrue(PushAlertState.registered(environment: .production).isWorking)
        XCTAssertFalse(PushAlertState.awaitingToken.isWorking)
        XCTAssertFalse(PushAlertState.notRequested.isWorking)
        XCTAssertFalse(PushAlertState.denied.isWorking)
        XCTAssertFalse(PushAlertState.failed("boom").isWorking)
        XCTAssertFalse(PushAlertState.unknown.isWorking)
    }

    func testSummariesNameTheRealProblemAndTheEnvironment() {
        XCTAssertTrue(PushAlertState.denied.summary.contains("iOS Settings"))
        XCTAssertTrue(PushAlertState.failed("token rejected").summary.contains("token rejected"))
        XCTAssertTrue(PushAlertState.registered(environment: .sandbox).summary.contains("sandbox"))
        XCTAssertTrue(PushAlertState.registered(environment: .production).summary.contains("production"))
    }
}
