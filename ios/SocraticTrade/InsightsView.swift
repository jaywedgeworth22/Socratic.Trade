import SwiftUI

/// Snapshot-derived status brief and prioritized attention items.
/// Not the web console Coach chat — rename keeps that product distinction clear.
struct InsightsView: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        SnapshotScaffold { snapshot in
            InsightsBriefCard(snapshot: snapshot)
            ForEach(insights(for: snapshot)) { insight in
                InsightCard(insight: insight)
            }
            InsightsActionCard(snapshot: snapshot)
            InsightsAuthorityCard()
        }
        .navigationTitle("Insights")
    }

    private func insights(for snapshot: MobileSnapshot) -> [StatusInsight] {
        var insights: [StatusInsight] = []

        if !snapshot.readiness.hasAccount {
            insights.append(.init(
                id: "account",
                title: "Choose an execution account",
                detail: "Open Account & Settings from Home to connect or select the account the agent should use.",
                systemImage: "person.crop.circle.badge.exclamationmark",
                tone: .warning
            ))
        } else if !snapshot.readiness.hasUniverse {
            insights.append(.init(
                id: "universe",
                title: "Your trading universe is empty",
                detail: "Add an included index or symbol before asking the strategy to find opportunities.",
                systemImage: "scope",
                tone: .warning
            ))
        }

        if !snapshot.pendingProposals.isEmpty {
            insights.append(.init(
                id: "proposals",
                title: "\(snapshot.pendingProposals.count) proposal\(snapshot.pendingProposals.count == 1 ? "" : "s") need a decision",
                detail: "Review rationale, size, execution environment, and any live confirmation in Proposals.",
                systemImage: "checklist",
                tone: .attention
            ))
        }

        if let cap = snapshot.policy.maxDailyNotional, cap > 0 {
            let utilization = min(max(snapshot.dailyStats.notional / cap, 0), 1)
            insights.append(.init(
                id: "daily-notional",
                title: "Daily opening notional is \(Int((utilization * 100).rounded()))% used",
                detail: "\(AppFormat.money(snapshot.dailyStats.notional)) of the owner-set \(AppFormat.money(cap)) daily cap.",
                systemImage: "gauge.with.dots.needle.50percent",
                tone: utilization >= 0.8 ? .warning : .neutral
            ))
        }

        if let benchmark = snapshot.performance?.benchmark {
            let ahead = benchmark.excessReturnPct >= 0
            insights.append(.init(
                id: "benchmark",
                title: ahead ? "Ahead of \(benchmark.benchmarkSymbol)" : "Behind \(benchmark.benchmarkSymbol)",
                detail: "You \(AppFormat.percent(benchmark.accountReturnPct, signed: true)) vs \(benchmark.benchmarkSymbol) \(AppFormat.percent(benchmark.benchmarkReturnPct, signed: true)) → excess \(AppFormat.percent(benchmark.excessReturnPct, signed: true)) across \(benchmark.points) observations.",
                systemImage: ahead ? "chart.line.uptrend.xyaxis" : "chart.line.downtrend.xyaxis",
                tone: ahead ? .positive : .attention
            ))
        }

        let triggeredAlerts = snapshot.alerts.filter { $0.status == "triggered" }
        if !triggeredAlerts.isEmpty {
            insights.append(.init(
                id: "triggered-alerts",
                title: "\(triggeredAlerts.count) price alert\(triggeredAlerts.count == 1 ? " has" : "s have") triggered",
                detail: "Review current prices and remove alerts you no longer need from Markets.",
                systemImage: "bell.badge.fill",
                tone: .attention
            ))
        }

        if insights.isEmpty {
            insights.append(.init(
                id: "clear",
                title: "No immediate action needed",
                detail: "The selected account is ready, the proposal queue is clear, and no tracked threshold needs attention.",
                systemImage: "checkmark.seal.fill",
                tone: .positive
            ))
        }

        return insights
    }
}

private struct InsightsBriefCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: "lightbulb.fill")
                        .font(.title2)
                        .foregroundStyle(AppPalette.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Portfolio brief")
                            .font(.title3.weight(.semibold))
                        Text("A concise read from the latest backend snapshot")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Text(brief)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var brief: String {
        let account = snapshot.readiness.activeConnectedAccount?.label ?? "No account"
        let state = snapshot.readiness.systemState.replacingOccurrences(of: "_", with: " ")
        let equity = AppFormat.money(snapshot.portfolio?.totalMarketValue)
        return "\(account) is \(state) with \(equity) in equity, \(snapshot.positions.count) open position\(snapshot.positions.count == 1 ? "" : "s"), and \(snapshot.pendingProposals.count) pending proposal\(snapshot.pendingProposals.count == 1 ? "" : "s"). The market session is \(snapshot.marketSession)."
    }
}

private struct StatusInsight: Identifiable {
    enum Tone {
        case neutral
        case positive
        case attention
        case warning
    }

    let id: String
    let title: String
    let detail: String
    let systemImage: String
    let tone: Tone

    var color: Color {
        switch tone {
        case .neutral: return AppPalette.accent
        case .positive: return AppPalette.positive
        case .attention: return AppPalette.warning
        case .warning: return AppPalette.negative
        }
    }
}

private struct InsightCard: View {
    let insight: StatusInsight

    var body: some View {
        AppCard {
            HStack(alignment: .top, spacing: 13) {
                Image(systemName: insight.systemImage)
                    .font(.headline)
                    .foregroundStyle(insight.color)
                    .frame(width: 38, height: 38)
                    .background(insight.color.opacity(0.11), in: Circle())
                VStack(alignment: .leading, spacing: 5) {
                    Text(insight.title)
                        .font(.headline)
                    Text(insight.detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

private struct InsightsActionCard: View {
    @EnvironmentObject private var store: MobileStore

    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 13) {
                SectionHeading("Ask for a fresh analysis", subtitle: "Queues a normal strategy run; it does not execute client-side inference.")
                CommandButton(
                    "Run Strategy Once",
                    systemImage: "sparkles",
                    isBusy: store.isBusy("strategy.run_once"),
                    isDisabled: !store.canSubmit("strategy.run_once"),
                    prominent: true
                ) {
                    Task { await store.submit("strategy.run_once") }
                }
                if !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse {
                    Text("Complete the readiness items above first. The backend will enforce the same requirements.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct InsightsAuthorityCard: View {
    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("The backend remains authoritative", systemImage: "lock.shield.fill")
                    .font(.headline)
                    .foregroundStyle(AppPalette.accent)
                Text("This tab summarizes server-returned facts. Broker credentials, provider keys, policy checks, proposal validation, and order placement never move onto the phone.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
