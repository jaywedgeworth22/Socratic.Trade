import SwiftUI

struct HomeView: View {
    @Binding var selectedTab: AppTab
    @State private var presentedSheet: HomeSheet?

    var body: some View {
        SnapshotScaffold { snapshot in
            let readinessIncomplete = !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse
            if readinessIncomplete {
                ReadinessChecklistHero(
                    snapshot: snapshot,
                    openSettings: { presentedSheet = .settings }
                )
            } else {
                ReadyHomeHero(snapshot: snapshot) {
                    selectedTab = .proposals
                }
            }
            AgentOverviewCard(snapshot: snapshot, showInlineReadiness: !readinessIncomplete)
            StrategyControlsCard(snapshot: snapshot)
            PortfolioOverviewCard(snapshot: snapshot)
            PerformanceOverviewCard(snapshot: snapshot)
            ScheduleOverviewCard(snapshot: snapshot)
            HomeAttentionCard(snapshot: snapshot)
        }
        .navigationTitle("Home")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    presentedSheet = .settings
                } label: {
                    Image(systemName: "person.crop.circle")
                }
                .accessibilityLabel("Account and settings")
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .settings:
                AccountSettingsView()
            }
        }
    }
}

/// Incomplete setup: checklist hero with CTAs (Account & Settings / universe instructions).
private struct ReadinessChecklistHero: View {
    let snapshot: MobileSnapshot
    let openSettings: () -> Void

    private var needsAccount: Bool { !snapshot.readiness.hasAccount }
    private var needsUniverse: Bool { !snapshot.readiness.hasUniverse }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(AppPalette.accent.opacity(0.14))
                        Image(systemName: "checklist")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(AppPalette.accent)
                    }
                    .frame(width: 44, height: 44)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Finish setup to trade")
                            .font(.title3.weight(.bold))
                        Text("Phone is a control remote — connect an account and symbol universe, then Run once.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    ChecklistRow(
                        done: !needsAccount,
                        title: "Connect a broker account",
                        detail: needsAccount
                            ? "Link Alpaca or Robinhood in the full desk, then select it here."
                            : (snapshot.readiness.activeConnectedAccount?.label ?? "Account ready")
                    )
                    ChecklistRow(
                        done: !needsUniverse,
                        title: "Add a symbol universe",
                        detail: needsUniverse
                            ? "In Socratic.Trade console → Strategy, include an index or symbols."
                            : "Universe ready for strategy runs"
                    )
                }

                if needsAccount {
                    Button(action: openSettings) {
                        Label("Account & Settings", systemImage: "person.crop.circle")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppPalette.accent)
                } else if needsUniverse {
                    Text("Open the desktop console to edit Strategy universe (indices + extra symbols), then pull to refresh here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct ChecklistRow: View {
    let done: Bool
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? AppPalette.positive : AppPalette.warning)
                .font(.body.weight(.semibold))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Ready state: equity + open P&L + agent state + primary CTA (Run once or Review N proposals).
private struct ReadyHomeHero: View {
    @EnvironmentObject private var store: MobileStore
    let snapshot: MobileSnapshot
    let onReviewProposals: () -> Void

    private var usesLiveMetrics: Bool {
        snapshot.readiness.activeConnectedAccount?.environment == "live"
    }

    private var openPnl: Double? {
        guard let performance = snapshot.performance else { return nil }
        return usesLiveMetrics ? performance.liveUnrealizedPnl : performance.paperUnrealizedPnl
    }

    private var pendingCount: Int { snapshot.pendingProposals.count }

    private var stateColor: Color {
        switch snapshot.readiness.systemState.lowercased() {
        case "active": return AppPalette.positive
        case "close_only", "liquidating": return AppPalette.warning
        default: return AppPalette.negative
        }
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(snapshot.readiness.activeConnectedAccount?.label ?? "Ready")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(AppFormat.money(snapshot.portfolio?.totalMarketValue, compact: true))
                            .font(.largeTitle.weight(.bold))
                            .foregroundStyle(AppPalette.accent)
                        Text("Equity")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 6) {
                        StatusPill(
                            snapshot.readiness.systemState.replacingOccurrences(of: "_", with: " ").capitalized,
                            color: stateColor,
                            systemImage: snapshot.readiness.systemState == "active" ? "bolt.fill" : "pause.fill"
                        )
                        Text(AppFormat.strategyAuthorityLabel(snapshot.readiness.strategyAuthority))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }

                HStack(spacing: 12) {
                    MetricTile(
                        title: "Open P&L",
                        value: AppFormat.money(openPnl),
                        detail: usesLiveMetrics ? "Live account" : "Paper account",
                        tint: pnlColor(openPnl)
                    )
                    MetricTile(
                        title: "Proposals",
                        value: "\(pendingCount)",
                        detail: pendingCount == 0 ? "None waiting" : "Awaiting review",
                        tint: pendingCount > 0 ? AppPalette.warning : AppPalette.accent
                    )
                }

                primaryCTA
            }
        }
    }

    @ViewBuilder
    private var primaryCTA: some View {
        if pendingCount > 0 {
            Button(action: onReviewProposals) {
                Label(
                    pendingCount == 1 ? "Review 1 proposal" : "Review \(pendingCount) proposals",
                    systemImage: "checklist"
                )
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(AppPalette.accent)
            .accessibilityHint("Opens the Proposals tab to approve or reject")
        } else {
            CommandButton(
                "Run once",
                systemImage: "sparkles",
                isBusy: store.isBusy("strategy.run_once"),
                isDisabled: !store.canSubmit("strategy.run_once"),
                prominent: true
            ) {
                Task { await store.submit("strategy.run_once") }
            }
        }
    }

    private func pnlColor(_ value: Double?) -> Color {
        guard let value else { return AppPalette.accent }
        return value >= 0 ? AppPalette.positive : AppPalette.negative
    }
}

private enum HomeSheet: String, Identifiable {
    case settings

    var id: String { rawValue }
}

private struct AgentOverviewCard: View {
    let snapshot: MobileSnapshot
    var showInlineReadiness: Bool = true

    private var stateColor: Color {
        switch snapshot.readiness.systemState.lowercased() {
        case "active": return AppPalette.positive
        case "close_only", "liquidating": return AppPalette.warning
        default: return AppPalette.negative
        }
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Socratic agent")
                            .font(.title2.weight(.bold))
                        Text(snapshot.readiness.activeConnectedAccount?.label ?? "No active account")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(
                        snapshot.readiness.systemState.replacingOccurrences(of: "_", with: " ").capitalized,
                        color: stateColor,
                        systemImage: snapshot.readiness.systemState == "active" ? "bolt.fill" : "pause.fill"
                    )
                }

                Divider()

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 20) {
                        statusLabels
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        statusLabels
                    }
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)

                if showInlineReadiness, !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse {
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(AppPalette.warning)
                        Text(readinessMessage)
                            .font(.subheadline)
                    }
                }
            }
        }
    }

    private var readinessMessage: String {
        if !snapshot.readiness.hasAccount {
            return "Connect an account in Socratic.Trade, then select it in Account & Settings before running the agent."
        }
        return "Add an index or symbol universe before requesting a strategy run."
    }

    @ViewBuilder
    private var statusLabels: some View {
        Label(AppFormat.strategyAuthorityLabel(snapshot.readiness.strategyAuthority), systemImage: "person.badge.shield.checkmark")
        Label(snapshot.marketSession.capitalized, systemImage: "chart.line.uptrend.xyaxis")
    }
}

private struct StrategyControlsCard: View {
    @EnvironmentObject private var store: MobileStore

    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                SectionHeading("Agent controls", subtitle: "Every action is validated and executed by the backend.")

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        runOnceButton
                        startButton
                    }
                    VStack(spacing: 10) {
                        runOnceButton
                        startButton
                    }
                }

                CommandButton(
                    "Stop agent",
                    systemImage: "stop.fill",
                    isBusy: store.isBusy("strategy.stop"),
                    role: .destructive
                ) {
                    submit("strategy.stop")
                }
                .tint(AppPalette.negative)

                Text("Stop immediately halts future broker submissions. A broker request already submitted before the halt may still complete; review existing orders in Markets.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if snapshot.readiness.commandBacklog.queued + snapshot.readiness.commandBacklog.running > 0 {
                    Text("\(snapshot.readiness.commandBacklog.queued) queued · \(snapshot.readiness.commandBacklog.running) running")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func submit(_ command: String) {
        Task { await store.submit(command) }
    }

    private var runOnceButton: some View {
        CommandButton(
            "Run once",
            systemImage: "sparkles",
            isBusy: store.isBusy("strategy.run_once"),
            isDisabled: !store.canSubmit("strategy.run_once"),
            prominent: true
        ) {
            submit("strategy.run_once")
        }
    }

    private var startButton: some View {
        CommandButton(
            "Start",
            systemImage: "play.fill",
            isBusy: store.isBusy("strategy.start"),
            isDisabled: !store.canSubmit("strategy.start")
        ) {
            submit("strategy.start")
        }
    }
}

private struct PortfolioOverviewCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Portfolio")
            if let portfolio = snapshot.portfolio {
                LazyVGrid(columns: columns, spacing: 10) {
                    MetricTile(title: "Equity", value: AppFormat.money(portfolio.totalMarketValue, compact: true))
                    MetricTile(title: "Buying power", value: AppFormat.money(portfolio.buyingPower, compact: true))
                    MetricTile(title: "Cash", value: AppFormat.money(portfolio.cash, compact: true))
                    MetricTile(title: "Positions", value: "\(snapshot.positions.count)", detail: "Open holdings")
                }
            } else {
                EmptyStateCard(
                    title: "No portfolio available",
                    message: "Select a connected account or retry when the broker is reachable.",
                    systemImage: "briefcase"
                )
            }
        }
    }

    private var columns: [GridItem] {
        [GridItem(.flexible()), GridItem(.flexible())]
    }
}

private struct PerformanceOverviewCard: View {
    let snapshot: MobileSnapshot

    private var usesLiveMetrics: Bool {
        snapshot.readiness.activeConnectedAccount?.environment == "live"
    }

    private var accountSubtitle: String {
        guard let environment = snapshot.readiness.activeConnectedAccount?.environment else {
            return "No active account"
        }
        return environment == "live" ? "Active live account" : "Active paper account"
    }

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Performance", subtitle: accountSubtitle)
            if let performance = snapshot.performance {
                LazyVGrid(columns: columns, spacing: 10) {
                    MetricTile(
                        title: "Realized P&L",
                        value: AppFormat.money(usesLiveMetrics ? performance.liveRealizedPnl : performance.paperRealizedPnl),
                        tint: pnlColor(usesLiveMetrics ? performance.liveRealizedPnl : performance.paperRealizedPnl)
                    )
                    MetricTile(
                        title: "Unrealized P&L",
                        value: AppFormat.money(usesLiveMetrics ? performance.liveUnrealizedPnl : performance.paperUnrealizedPnl),
                        tint: pnlColor(usesLiveMetrics ? performance.liveUnrealizedPnl : performance.paperUnrealizedPnl)
                    )
                    MetricTile(
                        title: "Win rate",
                        value: AppFormat.percent(usesLiveMetrics ? performance.liveWinRate : performance.paperWinRate)
                    )
                    MetricTile(
                        title: "Avg. return",
                        value: AppFormat.percent(
                            usesLiveMetrics ? performance.liveAverageReturnPct : performance.paperAverageReturnPct,
                            signed: true
                        )
                    )
                }

                if let benchmark = performance.benchmark {
                    AppCard {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("vs. \(benchmark.benchmarkSymbol)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(AppFormat.percent(benchmark.excessReturnPct, signed: true))
                                        .font(.headline)
                                        .foregroundStyle(pnlColor(benchmark.excessReturnPct))
                                }
                                Spacer()
                                Text("\(benchmark.points) observations")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(
                                "You \(AppFormat.percent(benchmark.accountReturnPct, signed: true)) · \(benchmark.benchmarkSymbol) \(AppFormat.percent(benchmark.benchmarkReturnPct, signed: true))"
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            Text("Account return minus \(benchmark.benchmarkSymbol) over the same window (cash flows neutralized).")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                EmptyStateCard(
                    title: "No performance history",
                    message: "Performance appears after the selected account has fills or portfolio snapshots.",
                    systemImage: "chart.xyaxis.line"
                )
            }
        }
    }

    private var columns: [GridItem] {
        [GridItem(.flexible()), GridItem(.flexible())]
    }

    private func pnlColor(_ value: Double?) -> Color {
        guard let value else { return AppPalette.accent }
        return value >= 0 ? AppPalette.positive : AppPalette.negative
    }
}

private struct ScheduleOverviewCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading("Schedule")
                LabeledContent("Last run", value: AppFormat.relative(snapshot.scheduler.lastRunAt))
                LabeledContent("Next run", value: AppFormat.relative(snapshot.scheduler.nextRunAt))
                LabeledContent(
                    "Cadence",
                    value: snapshot.policy.runCadenceMinutes.map { "Every \($0) min" } ?? "Manual"
                )
            }
        }
    }
}

private struct HomeAttentionCard: View {
    let snapshot: MobileSnapshot

    private var armedAlerts: Int {
        snapshot.alerts.filter { $0.status == "armed" }.count
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading("Needs attention")
                LabeledContent("Pending proposals", value: "\(snapshot.pendingProposals.count)")
                LabeledContent("Armed price alerts", value: "\(armedAlerts)")
                LabeledContent("Open orders", value: "\(snapshot.orders.count)")
                LabeledContent("Commands in flight", value: "\(snapshot.readiness.commandBacklog.queued + snapshot.readiness.commandBacklog.running)")
            }
        }
    }
}

private struct AccountSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var store: MobileStore

    @State private var deleteIdentity = ""
    @State private var deletePhrase = ""

    var body: some View {
        NavigationStack {
            Form {
                identitySection
                accountsSection
                policySection
                sessionSection
                deletionSection
            }
            .navigationTitle("Account & Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var identitySection: some View {
        Section("Signed in") {
            LabeledContent("Name", value: store.snapshot?.currentUser?.name ?? "—")
            LabeledContent("Email", value: store.snapshot?.currentUser?.email ?? "—")
            LabeledContent("Provider", value: store.snapshot?.currentUser?.loginProvider?.capitalized ?? "Not reported")
        }
    }

    @ViewBuilder
    private var accountsSection: some View {
        Section("Connected accounts") {
            if let accounts = store.snapshot?.connectedAccounts, !accounts.isEmpty {
                ForEach(accounts) { account in
                    ConnectedAccountSettingsRow(account: account)
                }
            } else {
                Text("No connected accounts. Connect one in Socratic.Trade, then return here to select it.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var policySection: some View {
        Section("Current policy") {
            LabeledContent("Authority", value: AppFormat.strategyAuthorityLabel(store.snapshot?.policy.strategyAuthority))
            LabeledContent("Horizon", value: store.snapshot?.policy.holdingHorizon?.capitalized ?? "—")
            LabeledContent("Max order", value: AppFormat.money(store.snapshot?.policy.maxOrderNotional))
            LabeledContent("Daily cap", value: AppFormat.money(store.snapshot?.policy.maxDailyNotional))
            LabeledContent("Daily orders", value: store.snapshot?.policy.maxDailyOrders.map(String.init) ?? "—")
        }
    }

    private var sessionSection: some View {
        Section {
            Button("Sign Out", role: .destructive) {
                store.clearLocalSession()
                dismiss()
            }
        } footer: {
            Text("Signing out clears the app’s local Socratic.Trade session. Broker and provider credentials remain on the backend.")
        }
    }

    @ViewBuilder
    private var deletionSection: some View {
        Section {
            if let deletion = store.deletionRequest {
                ForEach(Array(deletion.steps.enumerated()), id: \.offset) { index, step in
                    Label(step, systemImage: "\(index + 1).circle")
                        .font(.subheadline)
                }

                TextField(deletion.email ?? deletion.userId, text: $deleteIdentity)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField(deletion.requiredText, text: $deletePhrase)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()

                Button("Delete Account and Sign Out", role: .destructive) {
                    confirmDeletion()
                }
                .disabled(deletionConfirmationDisabled(deletion))

                Button("Hide Deletion Details") {
                    store.clearAccountDeletionPreview()
                    deleteIdentity = ""
                    deletePhrase = ""
                }
            } else {
                Button("Review Account Deletion", role: .destructive) {
                    Task { await store.loadAccountDeletionPreview() }
                }
                .disabled(store.isDeletingAccount)
            }
        } header: {
            Text("Delete account")
        } footer: {
            Text("Reviewing is read-only and does not pause the agent. Final confirmation prepares and deletes this app account, its server-stored secrets, proposals, fills, watchlists, alerts, and learned context. Provider-side OAuth grants must be revoked separately.")
        }
    }

    private func deletionConfirmationDisabled(_ deletion: AccountDeletionRequest) -> Bool {
        store.isDeletingAccount ||
        deleteIdentity.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() !=
            (deletion.email ?? deletion.userId).lowercased() ||
        deletePhrase.trimmingCharacters(in: .whitespacesAndNewlines) != deletion.requiredText
    }

    private func confirmDeletion() {
        Task {
            if let logoutURL = await store.confirmAccountDeletion(
                typedIdentity: deleteIdentity,
                typedText: deletePhrase
            ) {
                openURL(logoutURL)
                dismiss()
            }
        }
    }
}

private struct ConnectedAccountSettingsRow: View {
    @EnvironmentObject private var store: MobileStore
    @State private var confirmingLiveActivation = false

    let account: ConnectedAccount

    private var operationID: String { "account.activate:\(account.id)" }
    private var canActivate: Bool { store.canSubmit("account.activate") }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(account.label)
                    .font(.body.weight(.medium))
                Text("\(account.broker.capitalized) · \(account.environment.capitalized)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if account.isActive == true {
                StatusPill("Active", color: AppPalette.positive, systemImage: "checkmark")
            } else if store.isBusy(operationID) {
                ProgressView()
                    .accessibilityLabel("Switching to \(account.label)")
            } else {
                Button("Use") {
                    if account.environment.lowercased() == "live" {
                        confirmingLiveActivation = true
                    } else {
                        activate()
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(AppPalette.accent)
                .disabled(!canActivate)
                .opacity(canActivate ? 1 : 0.45)
                .accessibilityHint(canActivate
                    ? "Switch the active account to \(account.label)"
                    : "Unavailable until the app loads account data")
            }
        }
        .alert("Use Live Brokerage Account?", isPresented: $confirmingLiveActivation) {
            Button("Use Live Account", role: .destructive, action: activate)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Switch execution context to \(account.label) (\(account.broker.capitalized), live). Future approved actions will target this account after backend validation.")
        }
    }

    private func activate() {
        Task {
            await store.submit(
                "account.activate",
                payload: ["accountId": account.id],
                operationID: operationID
            )
        }
    }
}
