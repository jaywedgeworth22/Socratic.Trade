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
