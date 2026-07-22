import Foundation

struct MobileSnapshot: Decodable {
    let currentUser: CurrentUser?
    let readiness: Readiness
    let policy: PolicySummary
    let marketSession: String
    let scheduler: SchedulerSummary
    let portfolio: PortfolioSummary?
    let positions: [Position]
    let orders: [EquityOrder]
    let pendingProposals: [PendingProposal]
    let dailyStats: DailyStats
    let performance: PerformanceSummary?
    let connectedAccounts: [ConnectedAccount]
    let watchlist: [WatchlistItem]
    let alerts: [PriceAlert]
    let recentCommands: [MobileCommand]

    private enum CodingKeys: String, CodingKey {
        case currentUser
        case readiness
        case policy
        case marketSession
        case scheduler
        case portfolio
        case positions
        case orders
        case pendingProposals
        case dailyStats
        case performance
        case connectedAccounts
        case watchlist
        case alerts
        case recentCommands
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        currentUser = try values.decodeIfPresent(CurrentUser.self, forKey: .currentUser)
        readiness = try values.decode(Readiness.self, forKey: .readiness)
        policy = try values.decode(PolicySummary.self, forKey: .policy)
        marketSession = try values.decodeIfPresent(String.self, forKey: .marketSession) ?? "unknown"
        scheduler = try values.decodeIfPresent(SchedulerSummary.self, forKey: .scheduler) ?? .empty
        portfolio = try values.decodeIfPresent(PortfolioSummary.self, forKey: .portfolio)
        positions = try values.decodeIfPresent([Position].self, forKey: .positions) ?? []
        orders = try values.decodeIfPresent([EquityOrder].self, forKey: .orders) ?? []
        pendingProposals = try values.decodeIfPresent([PendingProposal].self, forKey: .pendingProposals) ?? []
        dailyStats = try values.decodeIfPresent(DailyStats.self, forKey: .dailyStats) ?? .empty
        performance = try values.decodeIfPresent(PerformanceSummary.self, forKey: .performance)
        connectedAccounts = try values.decodeIfPresent([ConnectedAccount].self, forKey: .connectedAccounts) ?? []
        watchlist = try values.decodeIfPresent([WatchlistItem].self, forKey: .watchlist) ?? []
        alerts = try values.decodeIfPresent([PriceAlert].self, forKey: .alerts) ?? []
        recentCommands = try values.decodeIfPresent([MobileCommand].self, forKey: .recentCommands) ?? []
    }
}

struct CurrentUser: Decodable {
    let userId: String
    let email: String?
    let name: String?
    let imageUrl: String?
    let loginProvider: String?
    let isAdmin: Bool?
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

struct ConnectedAccount: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
    let broker: String
    let environment: String
    let accountNumber: String?
    let isActive: Bool?
    let isDraining: Bool?
    let capabilities: AccountCapabilities?
}

struct AccountCapabilities: Decodable, Hashable {
    let equityTrading: Bool?
    let shortSelling: Bool?
    let optionsTrading: Bool?
    let optionsLevel: Int?
    let marginEnabled: Bool?
    let accountType: String?
}

struct PolicySummary: Decodable {
    let systemState: String
    let strategyAuthority: String
    let accountNumber: String?
    let connectedAccountId: String?
    let includedIndices: [String]?
    let additionalSymbols: [String]?
    let blocklist: [String]?
    let holdingHorizon: String?
    let runCadenceMinutes: Int?
    let maxOrderNotional: Double?
    let maxOrderPctOfNav: Double?
    let maxDailyNotional: Double?
    let maxDailyPctOfNav: Double?
    let maxDailyOrders: Int?
    let requireTypedConfirmation: Bool?
}

struct PortfolioSummary: Decodable {
    let accountNumber: String?
    let totalMarketValue: Double?
    let buyingPower: Double?
    let equityMarketValue: Double?
    let optionMarketValue: Double?
    let cash: Double?
}

struct Position: Decodable, Identifiable {
    var id: String { symbol }

    let symbol: String
    let quantity: Double
    let marketValue: Double
    let averageCost: Double?
    let sector: String?
    let industry: String?
}

struct EquityOrder: Decodable, Identifiable {
    let id: String
    let symbol: String
    let side: String
    let type: String
    let state: String
    let quantity: Double?
    let dollarAmount: Double?
    let filledQuantity: Double?
    let averagePrice: Double?
    let limitPrice: Double?
    let stopPrice: Double?
    let timeInForce: String?
    let createdAt: String?
    let updatedAt: String?
}

struct PendingProposal: Decodable, Identifiable {
    let id: String
    let createdAt: String?
    let accountNumber: String?
    let executionMode: String?
    let estimatedNotional: Double?
    let lastRevalidatedAt: String?
    let revalidationNote: String?
    let performanceSinceProposalPct: Double?
    let proposalReferencePrice: Double?
    let proposalCurrentPrice: Double?
    let proposal: Proposal
}

struct Proposal: Decodable {
    let symbol: String
    let side: String
    let type: String
    let quantity: Double?
    let dollarAmount: Double?
    let limitPrice: Double?
    let stopPrice: Double?
    let timeInForce: String?
    let rationale: String?
    let greenTeamRationale: String?
    let tradeThesisTag: String?
    let entryMarketRegime: String?
    let confidenceScore: Double?
    let proposedByModel: String?
    let reviewedByModel: String?
    let redTeamVerdict: RedTeamVerdict?
}

struct RedTeamVerdict: Decodable {
    let verdict: String?
    let rejected: Bool
    let available: Bool
    let reason: String
    let model: String?
    let overridden: Bool?
    let humanOverrideApplied: Bool?
    let failureKind: String?
}

func liveApprovalConfirmationText(forSymbol symbol: String) -> String {
    "APPROVE LIVE \(symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())"
}

struct LiveApprovalConfirmation {
    let proposalId: String
    let accountNumber: String?
    let estimatedNotional: Double?
    let typedText: String

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

struct DailyStats: Decodable {
    let orderCount: Int
    let openingOrderCount: Int
    let notional: Double

    static let empty = DailyStats(orderCount: 0, openingOrderCount: 0, notional: 0)
}

struct PerformanceSummary: Decodable {
    let liveRealizedPnl: Double?
    let paperRealizedPnl: Double?
    let liveUnrealizedPnl: Double?
    let paperUnrealizedPnl: Double?
    let liveWinRate: Double?
    let paperWinRate: Double?
    let liveAverageReturnPct: Double?
    let paperAverageReturnPct: Double?
    let benchmark: BenchmarkComparison?
    let fills: [FillEvent]?
}

struct BenchmarkComparison: Decodable {
    let accountReturnPct: Double
    let benchmarkReturnPct: Double
    let excessReturnPct: Double
    let startDate: String
    let endDate: String
    let points: Int
    let benchmarkSymbol: String
    let cashFlowAdjusted: Bool?
    let netExternalFlows: Double?
}

struct FillEvent: Decodable, Identifiable {
    let id: String
    let symbol: String
    let side: String
    let quantity: Double
    let price: Double
    let notional: Double
    let status: String
    let filledAt: String
}

struct SchedulerSummary: Decodable {
    let lastRunAt: String?
    let nextRunAt: String?

    static let empty = SchedulerSummary(lastRunAt: nil, nextRunAt: nil)
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
    let note: String?
    let status: String
    let createdAt: String?
    let triggeredAt: String?
    let triggeredPrice: Double?
}

struct MobileCommand: Decodable, Identifiable {
    let id: String
    let commandType: String
    let status: String
    let error: String?
    let createdAt: String
    let queuedAt: String?
    let startedAt: String?
    let finishedAt: String?
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
    // The current mobile deletion request contract does not return an expiry.
    // Keep this additive for compatibility with servers that add one later.
    let expiresAt: String?
    let steps: [String]
}

struct AccountDeletionResult: Decodable {
    let ok: Bool
    let deletedUserId: String
    let logoutUrl: String
}
