import SwiftUI

struct ActivityView: View {
    @EnvironmentObject private var store: MobileStore
    @State private var presentedItem: PresentedMarketItem?
    @State private var notificationFilter: NotificationHistoryFilter = .unread

    var body: some View {
        SnapshotScaffold { snapshot in
            NotificationHistorySection(
                snapshot: snapshot,
                filter: $notificationFilter,
                markRead: { ids in
                    await store.acknowledgeNotifications(ids: ids)
                }
            )
            DailyActivityCard(snapshot: snapshot)
            SchedulerActivityCard(snapshot: snapshot)
            FillActivitySection(fills: snapshot.performance?.fills ?? [], presentedItem: $presentedItem)
            CommandActivitySection(commands: snapshot.recentCommands)
        }
        .navigationTitle("Activity")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $presentedItem) { item in
            SymbolInfoSheet(item: item)
        }
    }
}

private enum NotificationHistoryFilter: String, CaseIterable, Identifiable {
    case unread = "Unread"
    case all = "All"

    var id: String { rawValue }
}

private struct NotificationHistorySection: View {
    let snapshot: MobileSnapshot
    @Binding var filter: NotificationHistoryFilter
    let markRead: ([String]) async -> Void

    @State private var ackingIds: Set<String> = []

    private var activeAccountId: String? {
        snapshot.readiness.activeConnectedAccount?.id ?? snapshot.policy.connectedAccountId
    }

    private var scoped: [NotificationHistoryItem] {
        snapshot.inScopeNotifications(activeAccountId: activeAccountId)
    }

    private var visible: [NotificationHistoryItem] {
        let rows = filter == .unread ? scoped.filter { !$0.read } : scoped
        return Array(rows.prefix(40))
    }

    private var unreadCount: Int {
        scoped.filter { !$0.read }.count
    }

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading(
                "Notifications",
                subtitle: "Alerts you can open later.  Refresh still shows them."
            )
            filterRow
            if visible.isEmpty {
                EmptyStateCard(
                    title: filter == .unread ? "No Unread Notifications" : "No Notifications Yet",
                    message: filter == .unread
                        ? "Nothing unread for this account.  Switch to All to see earlier alerts."
                        : "Fills, blocks, and run alerts will appear here after they are sent.",
                    systemImage: "bell"
                )
            } else {
                ForEach(visible) { item in
                    NotificationHistoryRow(
                        item: item,
                        acking: ackingIds.contains(item.id),
                        markRead: { await markOne(item) }
                    )
                }
            }
        }
    }

    private var filterRow: some View {
        HStack(spacing: 8) {
            ForEach(NotificationHistoryFilter.allCases) { option in
                Button {
                    filter = option
                } label: {
                    HStack(spacing: 6) {
                        Text(option.rawValue)
                        if option == .unread {
                            Text("\(unreadCount)")
                                .font(.appCaption2.weight(.bold))
                        }
                    }
                    .font(.appCaption.weight(filter == option ? .bold : .semibold))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 36)
                    .background(
                        filter == option ? AppPalette.accent.opacity(0.14) : Color.clear,
                        in: Capsule()
                    )
                    .foregroundStyle(filter == option ? AppPalette.accent : .secondary)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(filter == option ? .isSelected : [])
            }
            Spacer()
            if unreadCount > 0 {
                Button("Mark All Read") {
                    Task { await markAllVisibleUnread() }
                }
                .font(.appCaption.weight(.semibold))
                .disabled(!ackingIds.isEmpty)
            }
        }
    }

    private func markOne(_ item: NotificationHistoryItem) async {
        guard !item.read else { return }
        ackingIds.insert(item.id)
        defer { ackingIds.remove(item.id) }
        await markRead([item.id])
    }

    private func markAllVisibleUnread() async {
        let ids = visible.filter { !$0.read }.map(\.id)
        guard !ids.isEmpty else { return }
        ackingIds.formUnion(ids)
        defer { ackingIds.subtract(ids) }
        await markRead(ids)
    }
}

private struct NotificationHistoryRow: View {
    let item: NotificationHistoryItem
    let acking: Bool
    let markRead: () async -> Void

    var body: some View {
        AppCard(padding: 13) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .font(.appHeadline)
                        .foregroundStyle(.primary)
                    Spacer()
                    StatusPill(
                        item.readLabel,
                        color: item.read ? .secondary : AppPalette.accent,
                        systemImage: item.read ? "envelope.open" : "envelope.badge"
                    )
                }
                if !item.body.isEmpty {
                    Text(item.body)
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Text(AppFormat.dateTime(item.createdAt))
                        .font(.appFootnote)
                        .foregroundStyle(.secondary)
                    if let account = item.accountLabel, !account.isEmpty {
                        Text(account)
                            .font(.appFootnote)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    if !item.read {
                        Button {
                            Task { await markRead() }
                        } label: {
                            if acking {
                                ProgressView()
                            } else {
                                Text("Mark as Read")
                            }
                        }
                        .font(.appCaption.weight(.semibold))
                        .disabled(acking)
                        .accessibilityLabel("Mark as Read")
                    }
                }
            }
        }
        .opacity(item.read ? 0.72 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title), \(item.readLabel), \(AppFormat.dateTime(item.createdAt))")
    }
}

private struct DailyActivityCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Today", subtitle: "this trading day (New York)")
            AppMetricGrid {
                MetricTile(title: "All orders", value: "\(snapshot.dailyStats.orderCount)")
                MetricTile(title: "Opening orders", value: "\(snapshot.dailyStats.openingOrderCount)")
                MetricTile(
                    title: "Opening notional",
                    value: AppFormat.money(snapshot.dailyStats.notional, compact: true),
                    detail: dailyNotionalDetail(snapshot)
                )
                MetricTile(
                    title: "In Progress",
                    value: "\(snapshot.readiness.commandBacklog.queued + snapshot.readiness.commandBacklog.running)",
                    detail: "\(snapshot.readiness.commandBacklog.queued) queued · \(snapshot.readiness.commandBacklog.running) running"
                )
            }
        }
    }

    private func dailyNotionalDetail(_ snapshot: MobileSnapshot) -> String? {
        guard let cap = snapshot.policy.maxDailyNotional else { return nil }
        return "of \(AppFormat.money(cap, compact: true)) cap"
    }
}

private struct SchedulerActivityCard: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    SectionHeading("Scheduler")
                    Spacer()
                    // Shared market-aware run-state vocabulary (console deriveStateInfo parity).
                    StatusPill(
                        deriveRunStateWord(snapshot: snapshot).rawValue,
                        color: deriveRunStateWord(snapshot: snapshot).pillColor,
                        systemImage: "timer"
                    )
                }
                LabeledContent("Last Run", value: AppFormat.dateTime(snapshot.scheduler.lastRunAt))
                LabeledContent("Next run", value: AppFormat.dateTime(snapshot.scheduler.nextRunAt))
                LabeledContent("Cadence", value: snapshot.policy.runCadenceMinutes.map { "\($0) minutes" } ?? "Manual")
            }
        }
    }
}

private struct FillActivitySection: View {
    let fills: [FillEvent]
    @Binding var presentedItem: PresentedMarketItem?

    private var recentFills: [FillEvent] {
        Array(fills.sorted { $0.filledAt > $1.filledAt }.prefix(20))
    }

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Fills", subtitle: "Most recent executions")
            if recentFills.isEmpty {
                EmptyStateCard(
                    title: "No fills yet",
                    message: "Executed broker fills will appear here after the selected account trades.",
                    systemImage: "tray"
                )
            } else {
                ForEach(recentFills) { fill in
                    FillActivityRow(fill: fill, presentedItem: $presentedItem)
                }
            }
        }
    }
}

private struct FillActivityRow: View {
    let fill: FillEvent
    @Binding var presentedItem: PresentedMarketItem?

    var body: some View {
        Button {
            presentedItem = .fill(fill)
        } label: {
            AppCard(padding: 13) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            TickerLogo(symbol: fill.symbol, size: 30)
                            Text(fill.symbol)
                                .font(.appTitle3.weight(.bold))
                            Text(fill.side.uppercased())
                                .font(.appCaption.weight(.semibold))
                                .foregroundStyle(sideColor)
                        }
                        Text("\(AppFormat.number(fill.quantity)) @ \(AppFormat.money(fill.price))")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(AppFormat.money(fill.notional))
                            .font(.appTitle3.weight(.semibold))
                        Text(AppFormat.dateTime(fill.filledAt))
                            .font(.appFootnote)
                            .foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.appCaption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 6)
                }
            }
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(fill.symbol) \(fill.side) fill")
        .accessibilityHint("Opens fill and company details")
    }

    private var sideColor: Color {
        fill.side == "buy" || fill.side == "cover" ? AppPalette.positive : AppPalette.negative
    }
}

private struct CommandActivitySection: View {
    let commands: [MobileCommand]

    var body: some View {
        VStack(spacing: 10) {
            SectionHeading("Recent Actions", subtitle: "what you asked this app to do")
            if commands.isEmpty {
                EmptyStateCard(
                    title: "No Recent Actions",
                    message: "Actions you take here will show up here.",
                    systemImage: "list.bullet"
                )
            } else {
                ForEach(commands) { command in
                    CommandActivityRow(command: command)
                }
            }
        }
    }
}

private struct CommandActivityRow: View {
    let command: MobileCommand

    private var statusColor: Color {
        switch command.status {
        case "succeeded": return AppPalette.positive
        case "failed", "cancelled": return AppPalette.negative
        case "running", "queued": return AppPalette.warning
        default: return .secondary
        }
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(displayName)
                        .font(.appHeadline)
                    Spacer()
                    StatusPill(command.status.capitalized, color: statusColor, systemImage: statusIcon)
                }
                HStack {
                    Text(AppFormat.dateTime(command.updatedAt))
                        .font(.appFootnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                if let error = command.error, !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.negative)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var displayName: String {
        AppFormat.commandLabel(command.commandType)
    }

    private var statusIcon: String {
        switch command.status {
        case "succeeded": return "checkmark.circle.fill"
        case "failed", "cancelled": return "xmark.circle.fill"
        case "running": return "gearshape.2.fill"
        default: return "clock.fill"
        }
    }
}
