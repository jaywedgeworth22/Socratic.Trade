import Foundation

struct MobileSnapshot: Decodable {
    let currentUser: CurrentUser?
    let readiness: Readiness
    let policy: PolicySummary
    let portfolio: PortfolioSummary?
    let positions: [Position]
    let pendingProposals: [PendingProposal]
    let watchlist: [WatchlistItem]
    let alerts: [PriceAlert]
    let recentCommands: [MobileCommand]
}

struct CurrentUser: Decodable {
    let userId: String
    let email: String?
}

struct Readiness: Decodable {
    let hasAccount: Bool
    let hasUniverse: Bool
    let systemState: String
    let strategyAuthority: String
    let selectedAccountNumber: String?
    let activeConnectedAccount: ConnectedAccount?
    let commandBacklog: CommandBacklog
}

struct CommandBacklog: Decodable {
    let queued: Int
    let running: Int
}

struct ConnectedAccount: Decodable {
    let id: String
    let label: String
    let broker: String
    let environment: String
    let accountNumber: String?
}

struct PolicySummary: Decodable {
    let systemState: String
    let strategyAuthority: String
    let holdingHorizon: String?
    let maxOrderNotional: Double?
    let maxOrderPctOfNav: Double?
    let maxDailyNotional: Double?
    let maxDailyPctOfNav: Double?
    let maxDailyOrders: Int?
    // Owner-adjustable preference (see app/console/settings/page.tsx). Server always includes this
    // key today (app/api/mobile/snapshot/route.ts sends `!== false`), but decode it as optional and
    // default to "on" if it's ever missing, matching the server/PWA's own `!== false` semantics
    // (app/mobile/mobile-pwa-client.tsx `willPromptTyped`) rather than crashing the whole decode.
    let requireTypedConfirmation: Bool?
}

struct PortfolioSummary: Decodable {
    let totalMarketValue: Double?
    let buyingPower: Double?
    let cash: Double?
}

struct Position: Decodable, Identifiable {
    var id: String { symbol }
    let symbol: String
    let quantity: Double
    let marketValue: Double
    let averageCost: Double?
}

struct PendingProposal: Decodable, Identifiable {
    let id: String
    let accountNumber: String?
    let executionMode: String?
    let estimatedNotional: Double?
    let proposal: Proposal
}

struct Proposal: Decodable {
    let symbol: String
    let side: String
    let type: String
    let rationale: String?
}

/// Mirrors `liveApprovalText` in src/lib/strategy.ts (also used by app/mobile/mobile-pwa-client.tsx
/// and app/console/approvals/page.tsx): the exact phrase the server requires typed back before it
/// will approve a live-brokerage order.
func liveApprovalConfirmationText(forSymbol symbol: String) -> String {
    "APPROVE LIVE \(symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())"
}

/// Mirrors the `liveConfirmation` object the server requires in the `proposal.approve` command
/// payload for a broker/live order. Server side: src/lib/mobile-api.ts `normalizeCommandPayload`
/// ("proposal.approve" case) forwards this through to src/lib/strategy.ts
/// `assertLiveApprovalConfirmation`, which checks proposalId/accountNumber/executionMode/typedText/
/// estimatedNotional all match the reviewed proposal. Parity source (client shape):
/// app/mobile/mobile-pwa-client.tsx `submitCommand("proposal.approve", { liveConfirmation: ... })`.
struct LiveApprovalConfirmation {
    let proposalId: String
    let accountNumber: String?
    let estimatedNotional: Double?
    let typedText: String

    /// Built for `JSONSerialization`, not `Encodable`: `accountNumber` is omitted entirely when nil
    /// (mirroring the PWA, where `JSON.stringify` drops an `undefined` field) rather than being
    /// boxed as an `Optional<String>.none` inside `[String: Any]`, which `JSONSerialization` cannot
    /// serialize. `estimatedNotional` mirrors the PWA's explicit `?? null` instead.
    var jsonObject: [String: Any] {
        var object: [String: Any] = [
            "proposalId": proposalId,
            "executionMode": "broker/live",
            "estimatedNotional": estimatedNotional ?? NSNull(),
            "typedText": typedText
        ]
        if let accountNumber {
            object["accountNumber"] = accountNumber
        }
        return object
    }
}

struct WatchlistItem: Decodable, Identifiable {
    var id: String { symbol }
    let symbol: String
    let addedAt: String
}

struct PriceAlert: Decodable, Identifiable {
    let id: String
    let symbol: String
    let op: String
    let price: Double
    let status: String
}

struct MobileCommand: Decodable, Identifiable {
    let id: String
    let commandType: String
    let status: String
    let error: String?
    let createdAt: String
    let updatedAt: String
}

struct CommandEnvelope: Decodable {
    let command: MobileCommand
    let deduped: Bool?
}

struct DeletionRequestEnvelope: Decodable {
    let deletionRequest: AccountDeletionRequest
}

struct AccountDeletionRequest: Decodable {
    let requestId: String
    let userId: String
    let email: String?
    let requiredText: String
    let expiresAt: String
    let steps: [String]
}

struct AccountDeletionResult: Decodable {
    let ok: Bool
    let deletedUserId: String
    let logoutUrl: String
}

struct SnapshotEnvelope: Decodable {
    let currentUser: CurrentUser?
    let readiness: Readiness
    let policy: PolicySummary
    let portfolio: PortfolioSummary?
    let positions: [Position]
    let pendingProposals: [PendingProposal]
    let watchlist: [WatchlistItem]
    let alerts: [PriceAlert]
    let recentCommands: [MobileCommand]
}
