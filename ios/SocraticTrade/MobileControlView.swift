import SwiftUI

enum AppTab: String, CaseIterable, Identifiable {
    case home
    case proposals
    case markets
    case activity
    /// Snapshot brief + rule-based attention items — not the web console Coach chat.
    case insights

    var id: String { rawValue }

    @ViewBuilder
    var label: some View {
        switch self {
        case .home:
            Label("Home", systemImage: "house.fill")
        case .proposals:
            Label("Proposals", systemImage: "checklist")
        case .markets:
            Label("Markets", systemImage: "chart.line.uptrend.xyaxis")
        case .activity:
            Label("Activity", systemImage: "clock.arrow.circlepath")
        case .insights:
            Label("Insights", systemImage: "lightbulb.fill")
        }
    }
}

struct MobileControlView: View {
    @EnvironmentObject private var store: MobileStore
    @State private var selectedTab: AppTab = .home

    private var pendingProposalCount: Int {
        store.snapshot?.pendingProposals.count ?? 0
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                HomeView(selectedTab: $selectedTab)
            }
            .tabItem { AppTab.home.label }
            .tag(AppTab.home)

            NavigationStack {
                ProposalsView()
            }
            .tabItem { AppTab.proposals.label }
            .tag(AppTab.proposals)
            .badge(pendingProposalCount)

            NavigationStack {
                MarketsView()
            }
            .tabItem { AppTab.markets.label }
            .tag(AppTab.markets)

            NavigationStack {
                ActivityView()
            }
            .tabItem { AppTab.activity.label }
            .tag(AppTab.activity)

            NavigationStack {
                InsightsView()
            }
            .tabItem { AppTab.insights.label }
            .tag(AppTab.insights)
        }
        .tint(AppPalette.accent)
    }
}

#if DEBUG
#Preview("Five-tab shell") {
    MobileControlView()
        .environmentObject(MobileStore.preview)
}
#endif
